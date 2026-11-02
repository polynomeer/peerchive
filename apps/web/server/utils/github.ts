import { createGithubClient, type GithubClient } from '../modules/github/client'
import { githubAppConfig, type GithubAppConfig } from '../modules/github/config'
import type { GithubContext } from '../modules/github/connect'

let cached: { config: GithubAppConfig; client: GithubClient } | undefined

/**
 * GitHub App 클라이언트(프로세스당 하나, 설치 토큰 메모리 캐시를 공유). 설정이 바뀌면 새로 만듭니다.
 * 설정이 없으면 null(E-11 꺼짐, ADR 0056).
 */
export function useGithubClient(): { config: GithubAppConfig; client: GithubClient } | null {
  const config = githubAppConfig()
  if (!config) return null
  if (cached?.config !== config) cached = { config, client: createGithubClient(config) }
  return cached
}

/** GitHub 경로용 컨텍스트. 꺼져 있으면 404(그런 기능이 있는지도 드러내지 않음). */
export function requireGithubContext(): GithubContext {
  const github = useGithubClient()
  if (!github) throw createError({ statusCode: 404, statusMessage: 'Not Found', data: { code: 'not_found' } })
  return { ...github, siteOrigin: primarySiteOrigin() }
}
