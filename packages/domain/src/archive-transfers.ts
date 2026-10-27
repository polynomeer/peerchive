/**
 * 커뮤니티 → 아카이브 옮기기(C-09, PROOFU_EVOLUTION_PLAN §8.3·§8.5·§8.9.8, SYSTEM_DESIGN §6.7 ArchiveTransfer·§8.2·§8.3·§9,
 * DELIVERY_PLAN §4.1 C-09 "질문·채택 답변 → 막힘 로그·Q&A, 조언 글 → 선배 노트. 관련자 동의 전 복사 없음, 이름 표시 방식 재선택,
 * 원 글 열람 범위 유지", ADR 0025).
 *
 * - **채택된 답변**: 질문 게시판(board kind `question`)의 글쓴이가 최상위 댓글 하나를 채택합니다(바꾸기·풀기 가능, 글이 게시 중일 때만).
 * - **옮길 곳(target)**:
 *   - `course_qa`: 질문 + 채택된 답변 → 과목 허브의 "막힘 Q&A"(공개). 질문한 사람과 답한 사람의 동의(같은 사람이면 한 번). 각자 복사본에 쓸
 *     이름을 다시 고릅니다(익명 "질문한 학생"/"답한 학생", 표시명, 실명은 계정에 실명을 넣은 사람만).
 *   - `stuck_log`: 질문(+ 채택된 답변) → 질문한 사람의 비공개 과제에 🧱 막힘 로그(+ 💡 해결 로그). 답변을 넣으면 답한 사람의 동의가 필요합니다.
 *   - `senior_note`: 내가 쓴 글 → 과목 허브의 선배 노트 **초안**(요청이 곧 작성자 동의). 게시는 기존 선배 노트 절차(점검·확인)를 거칩니다.
 * - **동의 전 복사 없음**: 요청할 때 복사할 글을 스냅샷으로 얼려(원 글을 나중에 고쳐도 바뀌지 않음) 해시를 만들고, 동의는 그 해시에 묶입니다
 *   (T-11 manifest와 같은 방식). 모든 동의가 같은 해시로 모였을 때만 아카이브 쪽에 새 행을 만듭니다. 끝나거나 취소되면 스냅샷 글을 지웁니다.
 * - 거절은 어느 한 사람이라도 하면 취소, 요청한 사람은 언제든 취소, 14일이 지나면 만료.
 *
 * 런타임 의존성 없음(해시 계산은 서버가 canonicalJson + SHA-256으로).
 */
import { normalizeSearchText } from './course-hub'
import type { CheckItem } from './publication-checks'

export const ARCHIVE_TRANSFER_TARGETS = ['course_qa', 'stuck_log', 'senior_note'] as const
export type ArchiveTransferTarget = (typeof ARCHIVE_TRANSFER_TARGETS)[number]
export const ARCHIVE_TRANSFER_STATUSES = ['awaiting_consent', 'done', 'cancelled'] as const
export type ArchiveTransferStatus = (typeof ARCHIVE_TRANSFER_STATUSES)[number]
/** 취소 이유(코드만, 누가 거절했는지는 담지 않음). */
export const ARCHIVE_CANCEL_REASONS = [
  'cancelled_by_initiator',
  'declined',
  'expired',
  'source_unavailable',
  'answer_changed',
  'account_deleted',
  'target_unavailable',
] as const
export type ArchiveCancelReason = (typeof ARCHIVE_CANCEL_REASONS)[number]
export const ARCHIVE_CONSENT_ROLES = ['asker', 'answerer', 'author'] as const
export type ArchiveConsentRole = (typeof ARCHIVE_CONSENT_ROLES)[number]
export const ARCHIVE_CONSENT_STATUSES = ['pending', 'granted', 'declined'] as const
export type ArchiveConsentStatus = (typeof ARCHIVE_CONSENT_STATUSES)[number]
/** 복사본에 쓸 이름(막힘 Q&A). 원 글의 방식과 무관하게 다시 고릅니다. */
export const ARCHIVE_DISPLAY_MODES = ['anonymous', 'display', 'real'] as const
export type ArchiveDisplayMode = (typeof ARCHIVE_DISPLAY_MODES)[number]

/** 동의 기다리는 기간(14일). 지나면 만료(취소)입니다. */
export const ARCHIVE_TRANSFER_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** 사용자별 요청 한도(시간당). */
export const ARCHIVE_TRANSFER_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const
/** 표시명 최대 길이(선배 노트 표시명과 같음). */
export const ARCHIVE_LABEL_MAX = 40

export const ARCHIVE_TARGET_LABELS: Readonly<Record<ArchiveTransferTarget, string>> = {
  course_qa: '과목 허브 막힘 Q&A',
  stuck_log: '내 과제의 막힘 로그',
  senior_note: '선배 노트 초안',
}
export const ARCHIVE_STATUS_LABELS: Readonly<Record<ArchiveTransferStatus, string>> = {
  awaiting_consent: '동의 기다리는 중',
  done: '옮김',
  cancelled: '취소됨',
}
export const ARCHIVE_CANCEL_REASON_LABELS: Readonly<Record<ArchiveCancelReason, string>> = {
  cancelled_by_initiator: '요청한 사람이 취소했습니다.',
  declined: '동의하지 않은 사람이 있어 취소되었습니다.',
  expired: '14일 안에 동의가 모이지 않아 만료되었습니다.',
  source_unavailable: '원 글이나 답변이 지워졌거나 가려져 취소되었습니다.',
  answer_changed: '채택된 답변이 바뀌어 취소되었습니다.',
  account_deleted: '관련된 계정이 탈퇴해 취소되었습니다.',
  target_unavailable: '옮길 곳을 더 이상 쓸 수 없어 취소되었습니다.',
}
/** 원 글에 붙는 표시(그 글을 읽을 수 있는 사람에게만, 링크·동의한 사람 없음). */
export const ARCHIVED_MARKER_TEXT = '아카이브로 옮겨짐'
/** 익명으로 고른 사람의 복사본 이름. */
export const COURSE_QA_ANONYMOUS_LABELS: Readonly<Record<'asker' | 'answerer', string>> = { asker: '질문한 학생', answerer: '답한 학생' }
/** 요청한 사람에게 보이는 상대 동의 상태(답한 사람이 누구인지·무엇을 골랐는지는 없음). */
export const COUNTERPART_STATUS_LABELS: Readonly<Record<ArchiveConsentStatus, string>> = {
  pending: '답변자 동의 대기 중',
  granted: '답변자 동의함',
  declined: '답변자 거절함',
}

// ── 막힘 Q&A 복사본(아카이브 테이블) ────────────────────────────────────────

export const COURSE_QA_STATUSES = ['published', 'withdrawn', 'hidden'] as const
export type CourseQaStatus = (typeof COURSE_QA_STATUSES)[number]
export const COURSE_QA_TITLE_MAX = 120
export const COURSE_QA_QUESTION_MAX = 10_000
export const COURSE_QA_ANSWER_MAX = 3_000

// ── 요청 조건 ────────────────────────────────────────────────────────────

export interface TransferSourceFacts {
  target: ArchiveTransferTarget
  actorId: string
  boardKind: string
  post: { authorId: string; open: boolean }
  /** 채택된 답변(있고 지금 게시 중일 때만 open). */
  accepted: { authorId: string; open: boolean } | null
  /** stuck_log에서 답변까지 옮길지. course_qa는 항상 true. */
  includeAnswer: boolean
}

export type TransferStartCheck =
  | { ok: true }
  | { ok: false; reason: 'source_not_open' | 'not_author' | 'not_question_board' | 'no_accepted_answer' }

/**
 * 시작할 수 있는지. 원 글은 게시 중이어야 하고(지웠거나 가린 글은 안 됨), 요청한 사람은 원 글을 쓴 사람이어야 합니다.
 * course_qa·stuck_log는 질문 게시판의 글만, course_qa와 답변을 넣는 stuck_log는 게시 중인 채택된 답변이 있어야 합니다.
 */
export function canStartTransfer(f: TransferSourceFacts): TransferStartCheck {
  if (!f.post.open) return { ok: false, reason: 'source_not_open' }
  if (f.post.authorId !== f.actorId) return { ok: false, reason: 'not_author' }
  if (f.target === 'senior_note') return { ok: true }
  if (f.boardKind !== 'question') return { ok: false, reason: 'not_question_board' }
  const needsAnswer = f.target === 'course_qa' || f.includeAnswer
  if (needsAnswer && !(f.accepted && f.accepted.open)) return { ok: false, reason: 'no_accepted_answer' }
  return { ok: true }
}

export interface RequiredConsent {
  role: ArchiveConsentRole
  userId: string
}

/**
 * 필요한 동의. course_qa: 질문한 사람 + 답한 사람(같은 사람이면 한 번). stuck_log: 질문한 사람(+ 답변을 넣으면 답한 사람, 같은 사람이면 한 번).
 * senior_note: 작성자 한 사람(요청이 곧 동의).
 */
export function requiredConsents(input: { target: ArchiveTransferTarget; askerId: string; answererId: string | null; includeAnswer: boolean }): RequiredConsent[] {
  if (input.target === 'senior_note') return [{ role: 'author', userId: input.askerId }]
  const out: RequiredConsent[] = [{ role: 'asker', userId: input.askerId }]
  const withAnswer = input.target === 'course_qa' || input.includeAnswer
  if (withAnswer && input.answererId && input.answererId !== input.askerId) out.push({ role: 'answerer', userId: input.answererId })
  return out
}

/** 이 동의 상태들로 보면: 모두 같은 해시로 동의(complete) / 누군가 거절(declined) / 기다림(pending) / 해시가 다른 동의가 있음(stale). */
export function evaluateConsents(
  consents: ReadonlyArray<{ status: ArchiveConsentStatus; contentHash: string | null }>,
  currentHash: string,
): 'complete' | 'pending' | 'declined' | 'stale' {
  if (consents.length === 0) return 'pending'
  if (consents.some((c) => c.status === 'declined')) return 'declined'
  if (consents.some((c) => c.status === 'granted' && c.contentHash !== currentHash)) return 'stale'
  return consents.every((c) => c.status === 'granted') ? 'complete' : 'pending'
}

/** 동의를 기다리는 요청이 만료됐는지. */
export function isTransferExpired(t: { status: ArchiveTransferStatus; expiresAt: Date }, now: Date): boolean {
  return t.status === 'awaiting_consent' && t.expiresAt.getTime() <= now.getTime()
}

// ── 복사본 이름 ──────────────────────────────────────────────────────────

export type ArchiveLabelResult = { ok: true; label: string; anonymous: boolean } | { ok: false; reason: 'real_name_required' | 'display_persona_required' }

/**
 * 막힘 Q&A에 보일 이름. anonymous → "질문한 학생"/"답한 학생", display → 표시명 페르소나의 이름(있는 사람만, 계정 표시 이름이 아님 —
 * 계정 표시 이름은 실명 프로필의 공개 이름, ADR 0030), real → 계정 실명(입력한 사람만).
 * 원 글이 익명이었어도 고를 수 있습니다(복사본만 그 이름으로 보임, 원 글과의 연결은 공개 응답에 없음).
 */
export function archiveDisplayLabel(
  role: 'asker' | 'answerer',
  mode: ArchiveDisplayMode,
  names: { displayPersonaName: string | null; realName: string | null },
): ArchiveLabelResult {
  if (mode === 'anonymous') return { ok: true, label: COURSE_QA_ANONYMOUS_LABELS[role], anonymous: true }
  const raw = mode === 'real' ? names.realName : names.displayPersonaName
  const value = raw?.replace(/\s+/g, ' ').trim() ?? ''
  if (!value) return { ok: false, reason: mode === 'real' ? 'real_name_required' : 'display_persona_required' }
  return { ok: true, label: [...value].slice(0, ARCHIVE_LABEL_MAX).join(''), anonymous: false }
}

// ── 스냅샷·해시 ──────────────────────────────────────────────────────────

/** 요청 때 얼린 복사할 글. 끝나거나 취소되면 지웁니다. */
export interface ArchiveSnapshot {
  questionTitle: string
  questionBody: string
  /** 답변을 옮기지 않으면 null. */
  answerBody: string | null
}

/**
 * 동의가 묶이는 값(서버가 canonicalJson → SHA-256). 옮길 곳·과목·복사할 글·요청한 사람이 고른 이름이 들어갑니다.
 * 답한 사람이 고른 이름은 자기 동의 행에 남깁니다(요청한 사람은 그 선택을 미리 보지 않음).
 * 프로젝트 id는 넣지 않습니다(답한 사람에게 질문한 사람의 과제를 드러내지 않음).
 */
export function archiveHashInput(input: {
  target: ArchiveTransferTarget
  courseId: string | null
  snapshot: ArchiveSnapshot
  askerLabel: string | null
}): Record<string, unknown> {
  return {
    v: 1,
    target: input.target,
    courseId: input.courseId,
    questionTitle: input.snapshot.questionTitle,
    questionBody: input.snapshot.questionBody,
    answerBody: input.snapshot.answerBody,
    askerLabel: input.askerLabel,
  }
}

/** 공개 전 점검(publication-checks) 항목: 막힘 Q&A로 옮길 질문 제목·본문·답변. 두 사람 모두에게 같은 경고를 보여 줍니다. */
export function courseQaCheckItems(snapshot: ArchiveSnapshot): CheckItem[] {
  const items: CheckItem[] = [
    { kind: 'text', location: { kind: 'course_qa', field: 'questionTitle' }, value: snapshot.questionTitle },
    { kind: 'text', location: { kind: 'course_qa', field: 'questionBody' }, value: snapshot.questionBody },
  ]
  if (snapshot.answerBody) items.push({ kind: 'text', location: { kind: 'course_qa', field: 'answerBody' }, value: snapshot.answerBody })
  return items
}

// ── 알림 ─────────────────────────────────────────────────────────────────

export const ARCHIVE_NOTICE_KINDS = ['archive_consent_requested', 'archive_transfer_done', 'archive_transfer_cancelled'] as const
export type ArchiveNoticeKind = (typeof ARCHIVE_NOTICE_KINDS)[number]

export interface ArchiveNoticePayload {
  target: ArchiveTransferTarget
}

/** 알림 payload 허용 목록: 옮길 곳 종류만(누가 요청·거절했는지, 글 제목은 없음). */
export function sanitizeArchiveNoticePayload(raw: Readonly<Record<string, unknown>>): ArchiveNoticePayload | null {
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'target') return null
  return (ARCHIVE_TRANSFER_TARGETS as readonly unknown[]).includes(raw.target) ? { target: raw.target as ArchiveTransferTarget } : null
}

export function archiveNoticeText(kind: ArchiveNoticeKind, payload: ArchiveNoticePayload): string {
  const where = ARCHIVE_TARGET_LABELS[payload.target]
  switch (kind) {
    case 'archive_consent_requested':
      return `내가 쓴 답변을 ${where}(으)로 옮기는 데 동의를 요청받았습니다. 옮겨질 글을 확인하고 동의 여부를 정하세요.`
    case 'archive_transfer_done':
      return `${where}(으)로 옮기기가 끝났습니다.`
    case 'archive_transfer_cancelled':
      return `${where}(으)로 옮기기가 취소되었습니다.`
  }
}

// ── 검색 문서(파생 데이터) ────────────────────────────────────────────────

const squash = (value: string) => value.replace(/\s+/g, ' ').trim()
const clip = (value: string, max: number) => {
  const text = squash(value)
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text
}

/** 게시된 막힘 Q&A → 검색 문서 1개(질문 제목·본문·답변). 이름은 색인하지 않습니다. */
export function searchDocFromCourseQa(item: { questionTitle: string; questionBody: string; answerBody: string }): { title: string; snippet: string; searchText: string } {
  return {
    title: clip(item.questionTitle, 120),
    snippet: clip(item.questionBody, 200),
    searchText: normalizeSearchText(`${item.questionTitle}\n${item.questionBody}\n${item.answerBody}`),
  }
}
