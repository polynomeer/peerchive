/**
 * 공개 상태 전이 (SYSTEM_DESIGN §7.2).
 *
 * 서버가 게시 트랜잭션 안에서 다시 호출하는 것을 전제로 합니다.
 * 클라이언트 버튼 비활성은 보조 수단일 뿐이며, 이 함수의 결과가 최종 판정입니다.
 */

export const PUBLICATION_STATES = [
  'draft',
  'embargoed',
  'awaiting_consent',
  'ready',
  'published',
  'withdrawn',
  'restricted',
] as const
export type PublicationState = (typeof PUBLICATION_STATES)[number]

export const PUBLICATION_EVENTS = [
  /** 과목 학기 진행 중: draft → embargoed */
  'start_embargo',
  /** 학기 종료: embargoed → draft (자동 공개 아님, 알림만) */
  'end_embargo',
  /** 공개 후보(manifest) 생성: draft → awaiting_consent */
  'create_candidate',
  /** 동의·파일 검사·점검 통과: awaiting_consent → ready */
  'mark_ready',
  /** 내용 수정 / 새 후보: awaiting_consent → draft */
  'revise_candidate',
  /** 권한·엠바고 재검사 후 명시적 게시: ready → published */
  'publish',
  /** 철회·동의 철회·권리 문제: published → withdrawn */
  'withdraw',
  /** 운영 조치: published → restricted */
  'restrict',
  /** 철회 후 새 후보 작성: withdrawn → draft */
  'start_new_candidate',
  /** 조치 해제 후 재검토: restricted → draft */
  'lift_restriction',
] as const
export type PublicationEvent = (typeof PUBLICATION_EVENTS)[number]

export type FileScanStatus = 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed'
export type ConsentStatus = 'pending' | 'granted' | 'declined' | 'revoked'

export interface CandidateFile {
  artifactVersionId: string
  scanStatus: FileScanStatus
}

/** 공개 후보. manifest에는 선택된 revision·산출물 버전·노출 이름만 들어갑니다. */
export interface PublicationCandidate {
  manifestHash: string
  files: readonly CandidateFile[]
  /** 이 후보에 동의해야 하는 당사자(이름·발언·공동 산출물이 포함된 사람). */
  requiredConsentSubjectIds: readonly string[]
}

/** 동의는 특정 manifest 해시에 묶입니다. */
export interface Consent {
  subjectId: string
  manifestHash: string
  status: ConsentStatus
}

export interface PublicationContext {
  now: Date
  /** 적용 중인 엠바고 종료 시각(과목 학기 `ends_at` 또는 프로젝트 엠바고). 없으면 null. */
  embargoUntil?: Date | null
  candidate?: PublicationCandidate | null
  consents?: readonly Consent[]
  /** 보류·신고 등 열린 운영 hold가 있는지. */
  hasOpenHold?: boolean
}

export type PublicationBlocker =
  | { kind: 'candidate_missing' }
  | { kind: 'embargo_active'; until: Date }
  | { kind: 'embargo_not_applicable' }
  | { kind: 'consent_missing'; subjectId: string }
  /** 동의는 있으나 다른(낡은) manifest 해시에 대한 것. */
  | { kind: 'consent_stale'; subjectId: string; consentedHash: string; candidateHash: string }
  | { kind: 'file_not_clean'; artifactVersionId: string; scanStatus: FileScanStatus }
  | { kind: 'hold_open' }

export type TransitionError =
  | { code: 'INVALID_TRANSITION'; from: PublicationState; event: PublicationEvent }
  | { code: 'PRECONDITION_FAILED'; from: PublicationState; event: PublicationEvent; blockers: PublicationBlocker[] }

export type TransitionResult =
  | { ok: true; state: PublicationState }
  | { ok: false; error: TransitionError }

/** 이벤트별 허용 출발 상태와 도착 상태. 여기 없는 조합은 모두 INVALID_TRANSITION입니다. */
const TRANSITIONS: Readonly<Record<PublicationEvent, { from: PublicationState; to: PublicationState }>> = {
  start_embargo: { from: 'draft', to: 'embargoed' },
  end_embargo: { from: 'embargoed', to: 'draft' },
  create_candidate: { from: 'draft', to: 'awaiting_consent' },
  mark_ready: { from: 'awaiting_consent', to: 'ready' },
  revise_candidate: { from: 'awaiting_consent', to: 'draft' },
  publish: { from: 'ready', to: 'published' },
  withdraw: { from: 'published', to: 'withdrawn' },
  restrict: { from: 'published', to: 'restricted' },
  start_new_candidate: { from: 'withdrawn', to: 'draft' },
  lift_restriction: { from: 'restricted', to: 'draft' },
}

export function isEmbargoActive(ctx: Pick<PublicationContext, 'now' | 'embargoUntil'>): boolean {
  return ctx.embargoUntil != null && ctx.now.getTime() < ctx.embargoUntil.getTime()
}

function embargoBlockers(ctx: PublicationContext): PublicationBlocker[] {
  return isEmbargoActive(ctx) && ctx.embargoUntil ? [{ kind: 'embargo_active', until: ctx.embargoUntil }] : []
}

/** 후보의 동의·파일 상태 점검. mark_ready와 publish가 공유합니다. */
function candidateBlockers(ctx: PublicationContext): PublicationBlocker[] {
  const candidate = ctx.candidate
  if (!candidate) return [{ kind: 'candidate_missing' }]

  const blockers: PublicationBlocker[] = []
  const consents = ctx.consents ?? []

  for (const subjectId of candidate.requiredConsentSubjectIds) {
    const mine = consents.filter((c) => c.subjectId === subjectId)
    const current = mine.find((c) => c.manifestHash === candidate.manifestHash)
    if (current?.status === 'granted') continue
    const stale = mine.find((c) => c.status === 'granted' && c.manifestHash !== candidate.manifestHash)
    if (!current && stale) {
      blockers.push({
        kind: 'consent_stale',
        subjectId,
        consentedHash: stale.manifestHash,
        candidateHash: candidate.manifestHash,
      })
    } else {
      blockers.push({ kind: 'consent_missing', subjectId })
    }
  }

  for (const file of candidate.files) {
    if (file.scanStatus !== 'clean') {
      blockers.push({ kind: 'file_not_clean', artifactVersionId: file.artifactVersionId, scanStatus: file.scanStatus })
    }
  }
  return blockers
}

function holdBlockers(ctx: PublicationContext): PublicationBlocker[] {
  return ctx.hasOpenHold ? [{ kind: 'hold_open' }] : []
}

/** 이벤트별 전제 조건. 빈 배열이면 통과입니다. */
function preconditions(event: PublicationEvent, ctx: PublicationContext): PublicationBlocker[] {
  switch (event) {
    case 'start_embargo':
      // 학기 진행 중일 때만 엠바고 상태로 들어갑니다.
      return isEmbargoActive(ctx) ? [] : [{ kind: 'embargo_not_applicable' }]
    case 'end_embargo':
      return embargoBlockers(ctx)
    case 'create_candidate':
      return [...embargoBlockers(ctx), ...(ctx.candidate ? [] : [{ kind: 'candidate_missing' } as const])]
    case 'mark_ready':
      return [...candidateBlockers(ctx), ...holdBlockers(ctx)]
    case 'publish':
      // 게시 트랜잭션: 엠바고·동의(현재 manifest 해시)·파일 clean·hold를 모두 다시 검사합니다.
      return [...embargoBlockers(ctx), ...candidateBlockers(ctx), ...holdBlockers(ctx)]
    case 'start_new_candidate':
      // 철회된 release를 되살리지 않고, 새 후보 작성을 위해 draft로만 돌아갑니다.
      return []
    case 'revise_candidate':
    case 'withdraw':
    case 'restrict':
    case 'lift_restriction':
      return []
  }
}

export function transition(
  state: PublicationState,
  event: PublicationEvent,
  ctx: PublicationContext,
): TransitionResult {
  const rule = TRANSITIONS[event]
  if (rule.from !== state) {
    return { ok: false, error: { code: 'INVALID_TRANSITION', from: state, event } }
  }
  const blockers = preconditions(event, ctx)
  if (blockers.length > 0) {
    return { ok: false, error: { code: 'PRECONDITION_FAILED', from: state, event, blockers } }
  }
  return { ok: true, state: rule.to }
}

/** 현재 상태에서 형식상 가능한 이벤트 목록(전제 조건은 검사하지 않음). */
export function allowedEvents(state: PublicationState): PublicationEvent[] {
  return PUBLICATION_EVENTS.filter((event) => TRANSITIONS[event].from === state)
}
