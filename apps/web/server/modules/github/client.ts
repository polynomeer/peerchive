/**
 * GitHub REST API 클라이언트(E-11, ADR 0056). Octokit 없이 `fetch`만 씁니다(필요한 호출이 여덟 개뿐이고 런타임 의존성을 늘리지 않음).
 *
 * - 설치 토큰(installation access token, 1시간)은 **메모리에만** 캐시하고(만료 5분 전까지) DB·로그에 남기지 않습니다. 연결 해제 때
 *   `forgetInstallation`이 캐시에서 지우고 GitHub에 폐기(`DELETE /installation/token`)를 요청합니다.
 * - 사용자 토큰(user-to-server)은 OAuth 콜백 한 번 안에서만 쓰고 바로 폐기(`DELETE /applications/{client_id}/token`)합니다. 저장하지 않습니다.
 * - 요청마다 10초 제한. 오류 메시지에는 상태 코드와 호출 이름만 싣습니다(응답 본문·토큰 없음).
 * - 테스트는 `fetch`를 주입해 네트워크 없이 요청 모양만 봅니다.
 */
import { createAppJwt } from './app-auth'
import type { GithubAppConfig } from './config'

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_WEB = 'https://github.com'
const API_VERSION = '2022-11-28'
const TIMEOUT_MS = 10_000
/** 저장소 목록은 100개씩 최대 10쪽(1000개)까지. 과제 저장소를 고르는 데 충분합니다. */
const MAX_PAGES = 10

export interface GithubRepo {
  id: number
  fullName: string
  htmlUrl: string
  private: boolean
}

export interface GithubInstallation {
  id: number
  suspended: boolean
}

export interface GithubUser {
  id: number
  login: string
}

/** 서비스가 쓰는 GitHub 호출. 테스트는 이 인터페이스의 가짜를 넘깁니다. */
export interface GithubClient {
  /** 설치 정보. 없으면(제거됨) null. */
  getInstallation(installationId: number): Promise<GithubInstallation | null>
  /** 앱 설치에 들어 있는 저장소. 설치가 없으면 null. */
  listInstallationRepos(installationId: number): Promise<GithubRepo[] | null>
  /** OAuth code → 사용자 토큰. 잘못된 code면 null. */
  exchangeCode(code: string, redirectUri: string): Promise<string | null>
  getUser(userToken: string): Promise<GithubUser>
  /** 그 사용자가 이 설치에서 접근할 수 있는 저장소. 사용자가 설치에 접근할 수 없으면 null. */
  listUserInstallationRepos(userToken: string, installationId: number): Promise<GithubRepo[] | null>
  /** 사용자 토큰 폐기(실패해도 throw하지 않음). */
  revokeUserToken(userToken: string): Promise<void>
  /** 메모리 캐시의 설치 토큰을 지우고 GitHub에 폐기를 요청합니다(실패해도 throw하지 않음). */
  forgetInstallation(installationId: number): Promise<void>
}

export class GithubApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | null,
  ) {
    super(`GitHub API ${operation} failed${status === null ? '' : ` (${status})`}`)
    this.name = 'GithubApiError'
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface RepoPayload {
  id?: unknown
  full_name?: unknown
  html_url?: unknown
  private?: unknown
}

export function toRepo(raw: RepoPayload): GithubRepo | null {
  if (typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null
  if (typeof raw.full_name !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(raw.full_name)) return null
  if (typeof raw.html_url !== 'string' || !raw.html_url.startsWith(`${GITHUB_WEB}/`) || raw.html_url.length > 300) return null
  return { id: raw.id, fullName: raw.full_name, htmlUrl: raw.html_url, private: raw.private === true }
}

export function createGithubClient(config: GithubAppConfig, deps: { fetch?: FetchLike; now?: () => Date } = {}): GithubClient {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const now = deps.now ?? (() => new Date())
  const tokens = new Map<number, { token: string; expiresAt: number }>()

  async function call(operation: string, url: string, init: RequestInit & { auth?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'peerchive-github-app',
      ...(init.headers as Record<string, string> | undefined),
    }
    if (init.auth) headers.authorization = init.auth
    try {
      return await doFetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
    } catch {
      throw new GithubApiError(operation, null)
    }
  }

  async function json<T>(operation: string, response: Response): Promise<T> {
    if (!response.ok) throw new GithubApiError(operation, response.status)
    try {
      return (await response.json()) as T
    } catch {
      throw new GithubApiError(operation, response.status)
    }
  }

  const appAuth = () => `Bearer ${createAppJwt(config.appId, config.privateKey, now())}`

  async function installationToken(installationId: number): Promise<string | null> {
    const cached = tokens.get(installationId)
    if (cached && cached.expiresAt - 5 * 60_000 > now().getTime()) return cached.token
    const response = await call('installation_token', `${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      auth: appAuth(),
    })
    if (response.status === 404) return null
    const body = await json<{ token?: unknown; expires_at?: unknown }>('installation_token', response)
    if (typeof body.token !== 'string' || !body.token) throw new GithubApiError('installation_token', response.status)
    const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN
    tokens.set(installationId, { token: body.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now().getTime() + 30 * 60_000 })
    return body.token
  }

  async function pagedRepos(operation: string, url: string, auth: string): Promise<GithubRepo[] | null> {
    const repos: GithubRepo[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await call(operation, `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { auth })
      if (page === 1 && (response.status === 404 || response.status === 403)) return null
      const body = await json<{ repositories?: RepoPayload[]; total_count?: unknown }>(operation, response)
      const list = Array.isArray(body.repositories) ? body.repositories : []
      for (const raw of list) {
        const repo = toRepo(raw)
        if (repo) repos.push(repo)
      }
      if (list.length < 100) break
    }
    return repos
  }

  return {
    async getInstallation(installationId) {
      const response = await call('get_installation', `${GITHUB_API}/app/installations/${installationId}`, { auth: appAuth() })
      if (response.status === 404) return null
      const body = await json<{ id?: unknown; suspended_at?: unknown }>('get_installation', response)
      if (body.id !== installationId) throw new GithubApiError('get_installation', response.status)
      return { id: installationId, suspended: typeof body.suspended_at === 'string' && body.suspended_at.length > 0 }
    },

    async listInstallationRepos(installationId) {
      const token = await installationToken(installationId)
      if (!token) return null
      return pagedRepos('installation_repositories', `${GITHUB_API}/installation/repositories`, `Bearer ${token}`)
    },

    async exchangeCode(code, redirectUri) {
      const response = await call('oauth_exchange', `${GITHUB_WEB}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
      })
      const body = await json<{ access_token?: unknown; error?: unknown }>('oauth_exchange', response)
      return typeof body.access_token === 'string' && body.access_token ? body.access_token : null
    },

    async getUser(userToken) {
      const response = await call('get_user', `${GITHUB_API}/user`, { auth: `Bearer ${userToken}` })
      const body = await json<{ id?: unknown; login?: unknown }>('get_user', response)
      if (typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0) throw new GithubApiError('get_user', response.status)
      if (typeof body.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(body.login)) throw new GithubApiError('get_user', response.status)
      return { id: body.id, login: body.login }
    },

    async listUserInstallationRepos(userToken, installationId) {
      return pagedRepos('user_installation_repositories', `${GITHUB_API}/user/installations/${installationId}/repositories`, `Bearer ${userToken}`)
    },

    async revokeUserToken(userToken) {
      try {
        await call('revoke_user_token', `${GITHUB_API}/applications/${encodeURIComponent(config.clientId)}/token`, {
          method: 'DELETE',
          auth: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access_token: userToken }),
        })
      } catch {
        // 폐기 실패는 무시합니다(토큰은 저장하지 않았고 GitHub에서 만료됩니다).
      }
    },

    async forgetInstallation(installationId) {
      const cached = tokens.get(installationId)
      tokens.delete(installationId)
      if (!cached) return
      try {
        await call('revoke_installation_token', `${GITHUB_API}/installation/token`, { method: 'DELETE', auth: `Bearer ${cached.token}` })
      } catch {
        // 실패해도 캐시에서는 지웠고 토큰은 1시간 안에 만료됩니다.
      }
    },
  }
}
