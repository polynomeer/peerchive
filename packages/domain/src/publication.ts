/**
 * 공개 상태 전이 (SYSTEM_DESIGN §7.2).
 *
 * 서버가 게시 트랜잭션 안에서 다시 호출하는 것을 전제로 합니다.
 * 클라이언트 버튼 비활성은 보조 수단일 뿐이며, 이 함수의 결과가 최종 판정입니다.
 */
import { type Membership, type ProjectRef, type Viewer, canReadProjectWorkspace } from './permissions'

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
  /**
   * 게시 전 ready 조건이 다시 깨짐(동의 거절·철회, 파일 상태 변화, 보류) 또는 새 후보를 만들기 전: ready → awaiting_consent (T-11).
   * 게시(T-12)가 어차피 모든 조건을 다시 검사하지만, 저장된 상태가 현재 조건과 어긋나지 않게 합니다.
   */
  'reopen_candidate',
  /** 내용 수정 / 새 후보: awaiting_consent → draft */
  'revise_candidate',
  /** 권한·엠바고 재검사 후 명시적 게시: ready → published */
  'publish',
  /**
   * 게시 중인 공개의 새 버전 게시(T-12): published → published. publish와 같은 전제 조건을 다시 검사하고,
   * 이전 release는 replaced가 되어 더 이상 제공하지 않습니다(공개 버전 수정은 새 버전 생성, SYSTEM_DESIGN §1-7).
   */
  'republish',
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
  reopen_candidate: { from: 'ready', to: 'awaiting_consent' },
  revise_candidate: { from: 'awaiting_consent', to: 'draft' },
  publish: { from: 'ready', to: 'published' },
  republish: { from: 'published', to: 'published' },
  withdraw: { from: 'published', to: 'withdrawn' },
  restrict: { from: 'published', to: 'restricted' },
  start_new_candidate: { from: 'withdrawn', to: 'draft' },
  lift_restriction: { from: 'restricted', to: 'draft' },
}

/**
 * 공개 후보 준비(만들기·미리보기 전 선택): active owner/editor(§8 "공개 후보 준비 / 게시": editor는 후보 준비까지).
 * reviewer/viewer는 후보를 읽고 자기 관련 동의만 합니다.
 */
export function canPreparePublication(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && (membership!.role === 'owner' || membership!.role === 'editor')
}

/** 미동의자 제외 후보 만들기 등 공개 운영 결정: active owner만. 게시·전체 철회(T-12)도 owner입니다(§8, 대리 게시 없음). */
export function canManagePublication(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && membership!.role === 'owner'
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
    case 'republish':
      // 게시 트랜잭션: 엠바고·동의(현재 manifest 해시)·파일 clean·hold를 모두 다시 검사합니다.
      return [...embargoBlockers(ctx), ...candidateBlockers(ctx), ...holdBlockers(ctx)]
    case 'start_new_candidate':
      // 철회된 release를 되살리지 않고, 새 후보 작성을 위해 draft로만 돌아갑니다.
      return []
    case 'revise_candidate':
    case 'reopen_candidate':
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

// ── 공개 조회 판정 (T-12, SYSTEM_DESIGN §1-4·§11) ───────────────────────────

/** 공개 조회가 볼 상태. 모두 요청마다 DB에서 읽은 값이어야 합니다(캐시·worker 결과에 기대지 않음). */
export interface PublicReadState {
  publicationStatus: PublicationState
  /** current_release_id가 가리키는 release의 후보 상태. */
  releaseStatus: 'awaiting_consent' | 'ready' | 'superseded' | 'published' | 'withdrawn' | 'replaced'
  /** 그 release가 공개의 current_release인지. */
  isCurrentRelease: boolean
  /** 지금 적용 중인 엠바고가 있는지(게시 뒤에 걸린 엠바고도 공개 조회를 막음). */
  embargoActive: boolean
}

/**
 * 공개 페이지(JSON)를 내줄 수 있는지. 게시됨 + 지금 release + release도 게시됨 + 엠바고 없음일 때만.
 * 그 밖의 모든 경우(철회·제한·대체·엠바고·준비 중)는 같은 404로 답합니다(이유를 드러내지 않음).
 */
export function canServePublicRelease(state: PublicReadState): boolean {
  return (
    state.publicationStatus === 'published' &&
    state.releaseStatus === 'published' &&
    state.isCurrentRelease &&
    !state.embargoActive
  )
}

/**
 * 공개 파일을 내줄 수 있는지. 공개 페이지를 내줄 수 있고, 그 버전이 지금 release 스냅샷에 들어 있으며,
 * 지금도 clean일 때만. 같은 프로젝트의 clean 파일이라도 스냅샷에 없으면 내주지 않습니다.
 */
export function canServePublicArtifact(
  state: PublicReadState,
  file: { inCurrentSnapshot: boolean; scanStatus: FileScanStatus | null },
): boolean {
  return canServePublicRelease(state) && file.inCurrentSnapshot && file.scanStatus === 'clean'
}
