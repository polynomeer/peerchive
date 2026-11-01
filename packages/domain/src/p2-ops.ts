/**
 * P2 운영·계측 (A-07, DELIVERY_PLAN §4.3 A-07·§6.2 P2, ADR 0045).
 *
 * 1. 기관 인증 수단별 처리 큐: 초대 코드는 즉시(큐 없음), 기수 승인은 같은 기수 멤버의 승인 대기(운영자가 처리하지 않음 — 나이와 만료만 봄),
 *    수료증 확인은 운영자 처리 대기(건별 기한 `PEERCHIVE_CERTIFICATE_SLA_HOURS`, 기본 72시간 = §6.2 "수료증 확인 처리 중앙값 3일 이내").
 *    처리 시간은 파일을 받은 시각(uploaded_at) → 결정 시각(decided_at)입니다. 운영자가 볼 수 있는 시점부터 재야 운영 부담을 잽니다.
 * 2. §6.2 P2 지표(computeP2Metrics): 사람 행동은 분석 이벤트(사용자 키 있는 것만 사람으로 셈), 운영 기록·지금 상태는 개수로만.
 *    **모든 칸 5 미만 null**(ANALYTICS_MIN_GROUP), 비율은 분자·분모 중 하나라도 가려지면 null, 중앙값·p90은 표본 5 미만이면 null.
 *    영역 플래그가 꺼져 있으면 그 칸은 null입니다(화면은 칸을 숨김).
 * 런타임 의존성이 없습니다.
 */
import { ANALYTICS_MIN_GROUP, type AnalyticsEventRow, type RateMetric, suppressSmall } from './analytics'
import { type ReportSlaState, median, parseSlaHours, slaState } from './community-ops'
import { ROOM_ITEM_KINDS, type RoomItemKind } from './moderation'

const HOUR_MS = 60 * 60 * 1000

// ── 인증 수단별 처리 큐 ──────────────────────────────────────────────────

/** 수료증 확인 건별 기한(시간) 기본값: §6.2 "수료증 확인 처리 중앙값 3일 이내". */
export const CERTIFICATE_SLA_DEFAULT_HOURS = 72
export const CERTIFICATE_SLA_ENV = 'PEERCHIVE_CERTIFICATE_SLA_HOURS'
/** 수료증 처리 시간 중앙값 목표(시간, §6.2). 기한 값과 따로 둡니다(기한을 바꿔도 목표는 설계 값). */
export const CERTIFICATE_MEDIAN_TARGET_HOURS = 72

export function certificateSlaHours(env: Readonly<Record<string, string | undefined>>): number {
  return parseSlaHours(env[CERTIFICATE_SLA_ENV], CERTIFICATE_SLA_DEFAULT_HOURS)
}

/** 시작 시각부터 지금까지 시간(소수 첫째 자리, 음수면 0). */
export function ageHours(since: Date, now: Date): number {
  return Math.round((Math.max(0, now.getTime() - since.getTime()) / HOUR_MS) * 10) / 10
}

/** 대기 건 하나의 기한 판정(기한이 없으면 null — 기수 승인처럼 운영자가 처리하지 않는 큐). */
export function queueSla(since: Date, now: Date, targetHours: number | null): { state: ReportSlaState; dueAt: Date } | null {
  if (targetHours === null) return null
  return { state: slaState(Math.max(0, now.getTime() - since.getTime()), targetHours), dueAt: new Date(since.getTime() + targetHours * HOUR_MS) }
}

/** 백분위수(가장 가까운 순위, 0 < p ≤ 1). 빈 배열 null. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)))
  return sorted[rank - 1]!
}

export interface DecisionTimeSummary {
  /** 기간 안에 결정한 수(5 미만 null). */
  decided: number | null
  /** 받은 시각 → 결정 시각, 시간(소수 첫째 자리). 표본 5 미만 null. */
  medianHours: number | null
  p90Hours: number | null
  /** 건별 기한 안에 결정한 비율. */
  withinSla: RateMetric
  slaHours: number
  medianTargetHours: number
}

const toHours = (ms: number) => Math.round((ms / HOUR_MS) * 10) / 10

/** 수료증 처리 시간 요약. durationsMs는 기간 안에 결정한 건의 (결정 − 받은 시각). */
export function summarizeDecisionTimes(durationsMs: readonly number[], slaHours: number, minGroup = ANALYTICS_MIN_GROUP): DecisionTimeSummary {
  const enough = durationsMs.length >= minGroup
  const m = enough ? median(durationsMs) : null
  const p90 = enough ? percentile(durationsMs, 0.9) : null
  const within = durationsMs.filter((d) => d <= slaHours * HOUR_MS).length
  return {
    decided: suppressSmall(durationsMs.length, minGroup),
    medianHours: m === null ? null : toHours(m),
    p90Hours: p90 === null ? null : toHours(p90),
    withinSla: rate(within, durationsMs.length, minGroup),
    slaHours,
    medianTargetHours: CERTIFICATE_MEDIAN_TARGET_HOURS,
  }
}

// ── §6.2 P2 지표 ─────────────────────────────────────────────────────────

export const VERIFICATION_METHODS = ['email', 'invite_code', 'cohort_approval', 'certificate_check'] as const
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]

/** 기간 안에 들어온 방 항목 신고 한 줄. */
export interface RoomItemReportFact {
  kind: RoomItemKind
  reason: string
  /** 숨김으로 처리되고 되돌리지 않음. */
  confirmed: boolean
}

export interface P2MetricsInput {
  flags: { alumni: boolean; topics: boolean; institutions: boolean }
  /** 기간 [from, to) 안의 분석 이벤트. */
  events: readonly AnalyticsEventRow[]
  alumni: {
    /** 지금 보관되지 않은 동문회·OB 방 수. */
    rooms: number
    /** 그중 기간 안에 일정을 만들었거나 공지 글을 올린 방 수(§6.2 "월 1회 이상 일정·공지"의 기간 근사). */
    activeRooms: number
    /** 기간 안에 시작한 회차가 있는 일정들의 (일정, 응답한 사람) 수 / 그 일정들 방의 지금 active 멤버 수 합. */
    rsvpResponders: number
    rsvpAudience: number
    /** 지금 명부 행 수 / 명부를 쓸 수 있는(익명이 아닌) 동문 방의 active 멤버 수. */
    directoryConsented: number
    directoryEligible: number
    reports: readonly RoomItemReportFact[]
  }
  topics: {
    /** 기간 안에 쓴 토픽 답변(댓글) 수와 그중 선배 노트로 옮겨진(이동 완료) 수. */
    answers: number
    movedToNotes: number
    /** 기간 안 토픽 글·댓글 신고 중 소속·기수 사칭 사유 수와 그중 가리기로 확정된 수. */
    impersonationReports: number
    impersonationConfirmed: number
  }
  institutions: {
    /** 기간 안에 인증된(verified_at) 대학이 아닌 기관 소속 수(수단별). */
    verifiedByMethod: Readonly<Record<Exclude<VerificationMethod, 'email'>, number>>
    /** 기간 안에 결정한 수료증의 (결정 − 받은 시각) ms. */
    certificateDecisionMs: readonly number[]
    certificateSlaHours: number
    /** 기간 안에 운영자가 취소한 대학이 아닌 기관 소속(사칭 판정 등) 수. */
    revokedByOperator: number
    /** 기간 안 소속·기수 사칭 신고(방 항목·회고 포함, 토픽 글 제외) 수와 확정 수. */
    impersonationReports: number
    impersonationConfirmed: number
  }
}

export interface P2AlumniMetrics {
  /** 핵심(§6.2 졸업생 → 선배 노트 공급): 동문 방 활동(방 만들기·일정·응답·명부)을 한 사람 중 같은 기간에 선배 노트·수료 회고를 게시한 사람. */
  alumniToNotes: RateMetric
  /** 같은 기간 선배 노트·수료 회고 게시 수(사람과 무관한 합계). */
  supply: number | null
  /** 동문 방 활성(§6.2): 보관되지 않은 동문 방 중 기간 안에 일정·공지가 있던 방. */
  activeRooms: RateMetric
  /** 일정당 참석 응답률(§6.2). */
  rsvpRate: RateMetric
  /** 명부 동의율(§6.2, 관찰 지표, 지금 상태). */
  directoryConsent: RateMetric
  events: {
    alumniRoomsCreated: number | null
    cohortRoomsCreated: number | null
    eventsCreated: number | null
    rsvps: number | null
    directoryConsents: number | null
    directoryWithdrawals: number | null
  }
  /** 방 항목 신고(A-07): 종류별 수와 숨김 확정 수. */
  reportsByKind: Record<RoomItemKind, number | null>
  hiddenConfirmed: number | null
}

export interface P2TopicMetrics {
  /** 토픽 → 선배 노트 전환(§6.2): 기간 안 토픽 답변 중 선배 노트로 옮겨진 비율. */
  topicToNote: RateMetric
  /** 소속 표시 상향 비율(§6.2): 토픽 글 중 임계값 때문에 넓혀진 비율. */
  broadened: RateMetric
  postsByScope: { institution: number | null; institutionKind: number | null; none: number | null }
  impersonation: { reports: number | null; confirmed: number | null }
}

export interface P2InstitutionMetrics {
  /** 기관 인증(§6.2): 수단별 건수. 초대 코드는 즉시 인증이라 처리 시간이 없습니다. */
  verifiedByMethod: Record<Exclude<VerificationMethod, 'email'>, number | null>
  certificate: DecisionTimeSummary
  /** 사칭으로 판정된 인증(§6.2): 운영자 소속 취소 수, 소속·기수 사칭 신고와 확정 수. */
  impersonation: { revokedByOperator: number | null; reports: number | null; confirmed: number | null }
  retrosPublished: number | null
  /** 기관 확장 공급(§6.2 기관 기수 방에서 시작된 공개 사례·포트폴리오): 기수 방과 과제를 잇는 기록이 없어 재지 않습니다. */
  cohortRoomSupply: null
}

export interface P2Metrics {
  alumni: P2AlumniMetrics | null
  topics: P2TopicMetrics | null
  institutions: P2InstitutionMetrics | null
}

function rate(numerator: number, denominator: number, minGroup: number): RateMetric {
  const n = suppressSmall(numerator, minGroup)
  const d = suppressSmall(denominator, minGroup)
  return { numerator: n, denominator: d, rate: n === null || d === null || denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000 }
}

const ALUMNI_ACTIVITY_EVENTS = new Set(['alumni_room_created', 'event_created', 'rsvp_submitted', 'directory_consent_changed'])

/** §6.2 P2 지표(순수 함수). 꺼진 영역은 null. */
export function computeP2Metrics(input: P2MetricsInput, minGroup = ANALYTICS_MIN_GROUP): P2Metrics {
  const s = (n: number) => suppressSmall(n, minGroup)
  const named = (name: AnalyticsEventRow['name']) => input.events.filter((e) => e.name === name)
  const people = (rows: readonly AnalyticsEventRow[]) => new Set(rows.map((e) => e.actorHash).filter((h): h is string => h !== null))
  const supplyEvents = input.events.filter((e) => e.name === 'senior_note_published' || e.name === 'completion_retro_published')

  let alumni: P2AlumniMetrics | null = null
  if (input.flags.alumni) {
    const a = input.alumni
    const participants = people(input.events.filter((e) => ALUMNI_ACTIVITY_EVENTS.has(e.name)))
    const suppliers = people(supplyEvents)
    const converted = [...participants].filter((h) => suppliers.has(h)).length
    const rooms = named('alumni_room_created')
    const consent = named('directory_consent_changed')
    const reportsByKind = Object.fromEntries(ROOM_ITEM_KINDS.map((k) => [k, s(a.reports.filter((r) => r.kind === k).length)])) as Record<RoomItemKind, number | null>
    alumni = {
      alumniToNotes: rate(converted, participants.size, minGroup),
      supply: s(supplyEvents.length),
      activeRooms: rate(a.activeRooms, a.rooms, minGroup),
      rsvpRate: rate(a.rsvpResponders, a.rsvpAudience, minGroup),
      directoryConsent: rate(a.directoryConsented, a.directoryEligible, minGroup),
      events: {
        alumniRoomsCreated: s(rooms.length),
        cohortRoomsCreated: s(rooms.filter((e) => e.props.cohortRoom === true).length),
        eventsCreated: s(named('event_created').length),
        rsvps: s(named('rsvp_submitted').length),
        directoryConsents: s(consent.filter((e) => e.props.consented === true).length),
        directoryWithdrawals: s(consent.filter((e) => e.props.consented === false).length),
      },
      reportsByKind,
      hiddenConfirmed: s(a.reports.filter((r) => r.confirmed).length),
    }
  }

  let topics: P2TopicMetrics | null = null
  if (input.flags.topics) {
    const posts = named('topic_post_created')
    topics = {
      topicToNote: rate(input.topics.movedToNotes, input.topics.answers, minGroup),
      broadened: rate(posts.filter((e) => e.props.broadened === true).length, posts.length, minGroup),
      postsByScope: {
        institution: s(posts.filter((e) => e.props.labelScope === 'institution').length),
        institutionKind: s(posts.filter((e) => e.props.labelScope === 'institution_kind').length),
        none: s(posts.filter((e) => e.props.labelScope === 'none').length),
      },
      impersonation: { reports: s(input.topics.impersonationReports), confirmed: s(input.topics.impersonationConfirmed) },
    }
  }

  let institutions: P2InstitutionMetrics | null = null
  if (input.flags.institutions) {
    const i = input.institutions
    institutions = {
      verifiedByMethod: {
        invite_code: s(i.verifiedByMethod.invite_code),
        cohort_approval: s(i.verifiedByMethod.cohort_approval),
        certificate_check: s(i.verifiedByMethod.certificate_check),
      },
      certificate: summarizeDecisionTimes(i.certificateDecisionMs, i.certificateSlaHours, minGroup),
      impersonation: { revokedByOperator: s(i.revokedByOperator), reports: s(i.impersonationReports), confirmed: s(i.impersonationConfirmed) },
      retrosPublished: s(named('completion_retro_published').length),
      cohortRoomSupply: null,
    }
  }

  return { alumni, topics, institutions }
}
