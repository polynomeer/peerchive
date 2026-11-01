/**
 * P2 기능 플래그 (DELIVERY_PLAN §4.3·§7 GA 게이트, ADR 0037)와 P1 보완 백로그의 단계적 개방 플래그(DELIVERY_PLAN §4.4, ADR 0047).
 *
 * P2(졸업생·토픽·기관 확장)는 만들어 두되 기본은 꺼 둡니다. 여는 것은 pilot 근거가 필요한 운영 결정(GA 게이트)이라
 * 배포 설정으로만 켭니다. 서버가 요청마다 환경 변수를 읽고(바꾸려면 재시작), 꺼져 있으면 그 영역의 새 API는 404,
 * 화면 진입점은 숨깁니다(화면은 `GET /api/v1/features`로 같은 값을 받음).
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_FEATURE_P2 | off | `on`이면 아래 세 영역을 모두 켬(영역 변수가 `off`면 그 영역만 끔) |
 * | PEERCHIVE_FEATURE_P2_ALUMNI | off | 졸업생 공간(동문회·OB 방, A-01~A-04) |
 * | PEERCHIVE_FEATURE_P2_TOPICS | off | 토픽·소속 표시 익명(A-05·A-06) |
 * | PEERCHIVE_FEATURE_P2_INSTITUTIONS | off | 기관 확장(초대 코드·기수 승인·수료증 확인 I-01, 기관 페이지 I-02) |
 * | PEERCHIVE_FEATURE_HUB_STAGED_OPENING | off | 과목 허브 단계적 개방(E-02, P1 영역 — `PEERCHIVE_FEATURE_P2`를 따르지 않음) |
 * | PEERCHIVE_FEATURE_STUCK_QA | off | 막힘 Q&A 스레드(E-04, P1 영역 — `PEERCHIVE_FEATURE_P2`를 따르지 않음) |
 *
 * P1 영역(§4.4 "pilot 근거가 필요한 개방은 기본 꺼짐 플래그 뒤")은 자기 변수만 봅니다. P2 묶음 스위치로 켜지지 않습니다.
 * 켬: `on`·`1`·`true`·`yes`, 끔: `off`·`0`·`false`·`no`·빈 값(대소문자 무시). 그 밖의 값은 꺼짐으로 봅니다(잘못 쓴 값으로 열리지 않게).
 * 기존 기능(C-01 학교 메일 인증 등)은 이 플래그와 무관하게 그대로 동작합니다.
 *
 * 런타임 의존성 없음.
 */

/** P2 묶음 스위치(PEERCHIVE_FEATURE_P2)를 따르는 영역. */
export const P2_FEATURE_AREAS = ['alumni', 'topics', 'institutions'] as const
/** P1 보완 백로그(DELIVERY_PLAN §4.4)의 개방 플래그. 자기 변수만 봅니다. */
export const P1_FEATURE_AREAS = ['hubStagedOpening', 'stuckQa'] as const
export const FEATURE_AREAS = [...P2_FEATURE_AREAS, ...P1_FEATURE_AREAS] as const
export type FeatureArea = (typeof FEATURE_AREAS)[number]
export type FeatureFlags = Readonly<Record<FeatureArea, boolean>>

export const FEATURE_P2_ENV = 'PEERCHIVE_FEATURE_P2'
export const FEATURE_AREA_ENV: Readonly<Record<FeatureArea, string>> = {
  alumni: 'PEERCHIVE_FEATURE_P2_ALUMNI',
  topics: 'PEERCHIVE_FEATURE_P2_TOPICS',
  institutions: 'PEERCHIVE_FEATURE_P2_INSTITUTIONS',
  hubStagedOpening: 'PEERCHIVE_FEATURE_HUB_STAGED_OPENING',
  stuckQa: 'PEERCHIVE_FEATURE_STUCK_QA',
}

/** 모두 꺼진 값(기본). */
export const FEATURES_OFF: FeatureFlags = { alumni: false, topics: false, institutions: false, hubStagedOpening: false, stuckQa: false }

/** 플래그 값 해석: true(켬) / false(끔) / null(없음 — 상위 값을 따름). 알 수 없는 값은 false. */
export function parseFlagValue(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '') return null
  if (['on', '1', 'true', 'yes'].includes(value)) return true
  return false
}

/**
 * 환경 변수에서 영역별 플래그. P2 영역은 영역 변수가 있으면 그 값, 없으면 PEERCHIVE_FEATURE_P2 값, 둘 다 없으면 꺼짐.
 * P1 영역은 자기 변수만(없으면 꺼짐).
 */
export function parseFeatureFlags(env: Readonly<Record<string, string | undefined>>): FeatureFlags {
  const all = parseFlagValue(env[FEATURE_P2_ENV]) ?? false
  const out = {} as Record<FeatureArea, boolean>
  for (const area of P2_FEATURE_AREAS) out[area] = parseFlagValue(env[FEATURE_AREA_ENV[area]]) ?? all
  for (const area of P1_FEATURE_AREAS) out[area] = parseFlagValue(env[FEATURE_AREA_ENV[area]]) ?? false
  return out
}

/** 플래그 환경 변수 이름 전부(서버가 환경을 고를 때 씀). */
export const FEATURE_ENV_NAMES: readonly string[] = [FEATURE_P2_ENV, ...FEATURE_AREAS.map((a) => FEATURE_AREA_ENV[a])]
