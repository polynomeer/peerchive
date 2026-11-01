/**
 * P2 기능 플래그(서버, ADR 0037). 규칙·변수 표는 @peerchive/domain `features.ts`에 있습니다.
 *
 * - 요청마다 환경 변수를 읽습니다(바꾸려면 재시작). 기본은 모두 꺼짐.
 * - 꺼진 영역의 새 API는 `requireFeature(area)`로 404를 돌려줍니다(그런 기능이 있는지도 드러내지 않음). 서비스 함수 맨 앞에서 부르므로
 *   경로 처리기·테스트가 같은 판정을 받습니다.
 * - 화면은 `GET /api/v1/features`(로그인 없이)로 같은 값을 받아 진입점을 숨깁니다(useFeatures).
 * - A-01~A-07·I-02도 이 helper를 씁니다(영역: alumni·topics·institutions).
 */
import { FEATURE_ENV_NAMES, type FeatureArea, type FeatureFlags, parseFeatureFlags } from '@peerchive/domain'
import { notFound } from './errors'

type Env = Readonly<Record<string, string | undefined>>

let envOverride: Env | null = null
/** 테스트용: 환경 변수 대신 쓸 값(null이면 process.env). */
export function setFeatureEnvForTesting(env: Env | null): void {
  envOverride = env
}

/** 실행 시 환경(빌드 도구가 process.env를 상수로 바꾸지 않도록 이름으로 골라 읽음). */
function currentEnv(): Env {
  if (envOverride) return envOverride
  const env = (globalThis.process?.env ?? {}) as Env
  const out: Record<string, string | undefined> = {}
  for (const name of FEATURE_ENV_NAMES) out[name] = env[name]
  return out
}

export function featureFlags(): FeatureFlags {
  return parseFeatureFlags(currentEnv())
}

export function isFeatureOn(area: FeatureArea): boolean {
  return featureFlags()[area]
}

/** 꺼져 있으면 404. */
export function requireFeature(area: FeatureArea): void {
  if (!isFeatureOn(area)) throw notFound()
}
