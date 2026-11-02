/**
 * GitHub App 설정(E-11, ADR 0056). OAuth App이 아니라 GitHub App 하나로 설치(저장소 단위 권한)·웹훅·회원 확인(user-to-server OAuth)을 합니다.
 *
 * - 켜짐 = 여섯 값이 **모두** 있고 비공개 키(PEM)를 읽을 수 있을 때: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`,
 *   `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`. 하나라도 없으면 꺼짐(새 경로 404, 화면 진입점 없음).
 *   기능 플래그가 아니라 설정 여부입니다(E-05 임베딩 공급자와 같은 판단).
 * - 일부만 있거나 키를 읽을 수 없으면 꺼짐 + 경고 한 줄(값은 출력하지 않음). production에서는 웹훅 비밀이 32자 미만이면 꺼짐.
 * - 비공개 키는 env에 줄바꿈을 `\n`으로 적어도 됩니다(컨테이너 환경 변수 관행).
 * - 요청마다 환경을 다시 해석하지 않도록 값이 같으면 앞의 결과를 씁니다. 테스트는 `setGithubConfigForTesting`으로 바꿉니다.
 */
import { createPrivateKey, type KeyObject } from 'node:crypto'

export interface GithubAppConfig {
  appId: string
  privateKey: KeyObject
  webhookSecret: string
  slug: string
  clientId: string
  clientSecret: string
}

export const GITHUB_ENV_NAMES = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
] as const

/** production에서 요구하는 웹훅 비밀 최소 길이. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32

type Env = Readonly<Record<string, string | undefined>>

/** 환경 변수 → 설정. 꺼짐이면 `{ config: null, problem }`(problem은 경고용 짧은 이유, 값 없음). */
export function resolveGithubAppConfig(env: Env, options: { production: boolean }): { config: GithubAppConfig | null; problem: string | null } {
  const values = GITHUB_ENV_NAMES.map((name) => env[name]?.trim() ?? '')
  const present = values.filter(Boolean).length
  if (present === 0) return { config: null, problem: null }
  if (present < GITHUB_ENV_NAMES.length) {
    const missing = GITHUB_ENV_NAMES.filter((_, i) => !values[i])
    return { config: null, problem: `missing ${missing.join(', ')}` }
  }
  const [appId, rawKey, webhookSecret, slug, clientId, clientSecret] = values as [string, string, string, string, string, string]
  if (!/^\d{1,12}$/.test(appId)) return { config: null, problem: 'GITHUB_APP_ID must be numeric' }
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug)) return { config: null, problem: 'GITHUB_APP_SLUG is invalid' }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) return { config: null, problem: 'GITHUB_APP_CLIENT_ID is invalid' }
  if (options.production && webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    return { config: null, problem: `GITHUB_APP_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters` }
  }
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey({ key: rawKey.replace(/\\n/g, '\n'), format: 'pem' })
  } catch {
    return { config: null, problem: 'GITHUB_APP_PRIVATE_KEY is not a readable PEM key' }
  }
  if (privateKey.asymmetricKeyType !== 'rsa') return { config: null, problem: 'GITHUB_APP_PRIVATE_KEY must be an RSA key' }
  return { config: { appId, privateKey, webhookSecret, slug, clientId, clientSecret }, problem: null }
}

let override: { config: GithubAppConfig | null } | null = null
let cached: { key: string; config: GithubAppConfig | null } | undefined

/** 테스트용: 설정을 직접 넣습니다(null이면 꺼짐). `undefined`로 부르면 환경 변수로 돌아갑니다. */
export function setGithubConfigForTesting(config: GithubAppConfig | null | undefined): void {
  override = config === undefined ? null : { config }
}

function isProductionEnv(env: Env): boolean {
  return env['NODE_ENV'] === 'production'
}

/** 지금 설정(꺼짐이면 null). */
export function githubAppConfig(): GithubAppConfig | null {
  if (override) return override.config
  const raw = (globalThis.process?.env ?? {}) as Env
  const env: Record<string, string | undefined> = { NODE_ENV: raw['NODE_ENV'] }
  for (const name of GITHUB_ENV_NAMES) env[name] = raw[name]
  const key = JSON.stringify(env)
  if (cached?.key !== key) {
    const { config, problem } = resolveGithubAppConfig(env, { production: isProductionEnv(env) })
    if (problem) console.warn(`[github] GitHub App integration is off: ${problem}`)
    cached = { key, config }
  }
  return cached.config
}

export function githubEnabled(): boolean {
  return githubAppConfig() !== null
}
