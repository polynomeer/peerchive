/**
 * 공개 프로필·팔로우 지표 (S-07, DELIVERY_PLAN §6.2 P1, ADR 0036). 운영자 지표(`GET /operator/metrics`)의 `profile` 칸입니다.
 *
 * - 사람 행동은 분석 이벤트(수집 거부한 사람 제외, 사용자 키 있는 이벤트만 사람으로 셈), 운영 행동(신고·조치·작성자 확인)과 지금 상태(활성 팔로우 수·
 *   팔로워 수 표시 설정)는 운영 기록에서 **개수로만** 셉니다(C-10 커뮤니티 지표와 같은 원칙).
 * - **모든 칸 5 미만 null**(ANALYTICS_MIN_GROUP). 비율은 분자·분모 중 하나라도 가려지면 null.
 * - 팔로워 수·피드 노출 수를 개인 지표나 순위로 쓰지 않습니다(§6.2): 여기 있는 값은 모두 전체 합계·비율입니다.
 * - 정체성 누출(필수, §6.2)은 이벤트로 잴 수 없습니다(누출을 발견한 신고·사고 기록으로 셈). S-02 속성 테스트와 RUNBOOK GP 점검이 자리입니다.
 */
import { ANALYTICS_MIN_GROUP, type AnalyticsEventRow, type RateMetric, suppressSmall } from './analytics'

/** 신고 운영 기록 한 줄(기간 안에 들어온 페르소나·프로필 글·소셜 링크·실명 프로필 신고). */
export interface ProfileReportFact {
  targetType: 'persona' | 'profile_post' | 'social_link' | 'profile'
  reason: string
  /** 신고된 페르소나의 종류(프로필 글·링크는 그 글·링크의 페르소나). 탈퇴 정리로 페르소나가 없으면 null. */
  personaKind: 'real' | 'display' | null
  /** 숨김 조치로 처리됨(확정). */
  confirmed: boolean
}

export interface ProfileMetricsInput {
  /** 기간 [from, to) 안의 분석 이벤트. */
  events: readonly AnalyticsEventRow[]
  reports: readonly ProfileReportFact[]
  /** 지금 active 팔로우 관계 수. */
  activeFollows: number
  /** 지금 공개 상태인 페르소나 수(실명·표시명)와 그중 팔로워 수 표시를 켠 수. */
  personas: { real: number; display: number; followerCountShown: number }
  /** 기간 안의 운영자 페르소나 주인 확인 건수(신고와 이어지지 않은 확인은 만들 수 없음). */
  ownerLookups: number
}

export interface ProfileMetrics {
  /** 피드에서 항목을 연 서로 다른 사람. */
  feedUsers: number | null
  /** 핵심(§6.2): 피드 사용자 중 기간 안에 ‘도움됐어요’·포크를 남긴 사람(같은 기간 근사, 이벤트끼리 잇지 않음). */
  followToRecord: RateMetric
  /** 피드에서 연 항목 중 기록(공개 사례·선배 노트·스터디 기록)의 비율. 노출 수는 재지 않아 연 항목으로 근사. */
  feedComposition: RateMetric
  /** 기간 안에 만든 페르소나: 실명 → 표시명(분모 실명, 분자 표시명을 만든 사람). */
  displayAdoption: RateMetric
  /** 연결 켜기·끄기 횟수. */
  identityLink: { turnedOn: number | null; turnedOff: number | null }
  /** 표시명 사칭(§6.2): 표시명 프로필 대상 사칭 신고 수와 그중 숨김으로 확정된 수. */
  impersonation: { reports: number | null; confirmed: number | null }
  /** 대상 종류별 신고 수. */
  reportsByTarget: { persona: number | null; profilePost: number | null; socialLink: number | null; legacyProfile: number | null }
  /** 확인된 소셜 링크(§6.2 소셜 링크 유입): 확인 이벤트 수와 확인을 얻은 서로 다른 사람. */
  socialLinksVerified: { events: number | null; users: number | null }
  /** 차단·뮤트·팔로워 삭제(§6.2): 개수와 활성 팔로우 1,000건당(지금 팔로우 수 기준 근사). */
  relationRemovals: { blocks: number | null; mutes: number | null; followerRemovals: number | null; activeFollows: number | null; per1000Follows: number | null }
  /** 팔로우 요청(대기 포함)·승인 수. */
  follows: { requested: number | null; pending: number | null; approved: number | null; fromSuggestions: number | null }
  /** 팔로워 수 표시를 켠 공개 페르소나 비율(§6.2 팔로워 수 표시 선택, 지금 상태). */
  followerCountShown: RateMetric
  /** 공개 범위·과제 수행 목록 변경 수. */
  settings: { visibilityChanged: number | null; projectListed: number | null }
  ownerLookups: number | null
}

const RECORD_SOURCES = new Set(['publication_release', 'senior_note', 'study_release'])

function rate(numerator: number, denominator: number, minGroup: number): RateMetric {
  const n = suppressSmall(numerator, minGroup)
  const d = suppressSmall(denominator, minGroup)
  return { numerator: n, denominator: d, rate: n === null || d === null || denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000 }
}

/** 공개 프로필·팔로우 지표(순수 함수). events는 이미 기간 안의 것만 넘깁니다. */
export function computeProfileMetrics(input: ProfileMetricsInput, minGroup = ANALYTICS_MIN_GROUP): ProfileMetrics {
  const s = (n: number) => suppressSmall(n, minGroup)
  const named = (name: AnalyticsEventRow['name']) => input.events.filter((e) => e.name === name)
  const people = (rows: readonly AnalyticsEventRow[]) => new Set(rows.map((e) => e.actorHash).filter((h): h is string => h !== null))

  const opened = named('feed_item_opened')
  const feedUsers = people(opened)
  const recordUsers = people(input.events.filter((e) => (e.name === 'usefulness_marked' && e.props.kind === 'helped') || e.name === 'plan_forked'))
  const converted = [...feedUsers].filter((h) => recordUsers.has(h)).length
  const openedRecords = opened.filter((e) => RECORD_SOURCES.has(String(e.props.sourceType))).length

  const created = named('persona_created')
  const realCreators = people(created.filter((e) => e.props.kind === 'real'))
  const displayCreators = people(created.filter((e) => e.props.kind === 'display'))
  const toggles = named('identity_link_toggled')

  const impersonation = input.reports.filter((r) => r.reason === 'impersonation' && r.personaKind === 'display')
  const byTarget = (t: ProfileReportFact['targetType']) => input.reports.filter((r) => r.targetType === t).length

  const verified = named('social_link_verified')
  const blocks = named('block_created').length
  const mutes = named('mute_created').length
  const removals = named('follower_removed').length
  const removalTotal = blocks + mutes + removals
  const per1000 =
    s(removalTotal) === null || s(input.activeFollows) === null ? null : Math.round((removalTotal / input.activeFollows) * 1000 * 10) / 10

  const requested = named('follow_requested')
  const publicPersonas = input.personas.real + input.personas.display

  return {
    feedUsers: s(feedUsers.size),
    followToRecord: rate(converted, feedUsers.size, minGroup),
    feedComposition: rate(openedRecords, opened.length, minGroup),
    displayAdoption: rate(displayCreators.size, realCreators.size, minGroup),
    identityLink: { turnedOn: s(toggles.filter((e) => e.props.visible === true).length), turnedOff: s(toggles.filter((e) => e.props.visible === false).length) },
    impersonation: { reports: s(impersonation.length), confirmed: s(impersonation.filter((r) => r.confirmed).length) },
    reportsByTarget: { persona: s(byTarget('persona')), profilePost: s(byTarget('profile_post')), socialLink: s(byTarget('social_link')), legacyProfile: s(byTarget('profile')) },
    socialLinksVerified: { events: s(verified.length), users: s(people(verified).size) },
    relationRemovals: { blocks: s(blocks), mutes: s(mutes), followerRemovals: s(removals), activeFollows: s(input.activeFollows), per1000Follows: per1000 },
    follows: {
      requested: s(requested.length),
      pending: s(requested.filter((e) => e.props.pending === true).length),
      approved: s(named('follow_approved').length),
      fromSuggestions: s(requested.filter((e) => e.props.origin === 'suggestion').length),
    },
    followerCountShown: rate(input.personas.followerCountShown, publicPersonas, minGroup),
    settings: { visibilityChanged: s(named('visibility_changed').length), projectListed: s(named('project_listed').length) },
    ownerLookups: s(input.ownerLookups),
  }
}
