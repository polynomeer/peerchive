/**
 * 막힘 Q&A 스레드 (E-04, PROOFU_EVOLUTION_PLAN §8.5·§8.6, DELIVERY_PLAN §4.4 E-04, ADR 0049).
 *
 * 공개된 🧱 막힘 카드(지금 게시 중인 release 스냅샷의 막힘 로그)에 그 로그를 쓴 사람이 "질문 허용"을 켜면, 학교 인증 계정이 질문 스레드를 열고
 * 답할 수 있습니다. 이 파일은 규칙(익명 번호·표시·정렬·글 길이)만 담고 런타임 의존성이 없습니다.
 *
 * - **스레드 단위 익명 번호**: 질문한 사람은 0(`질문자`), 그 밖의 사람은 그 스레드에 처음 쓴 순서대로 1, 2, …(`익명N`). 같은 스레드에서는 같은
 *   번호를 유지하고 스레드 사이에는 번호를 공유하지 않습니다. 막힘 로그 작성자는 번호를 받지 않고 항상 `작성자`입니다.
 * - 이름은 어디에도 나오지 않습니다(모두 익명). 커뮤니티의 스레드 번호(C-04 `assignThreadAlias`)와 같은 모양이지만 커뮤니티 코드에 기대지 않습니다
 *   (과목 허브는 공개 경로라 커뮤니티 모듈을 import하지 않음, C-05).
 * - "도움됐어요"는 답변별로 남기며 **정렬에만** 씁니다(카드 안 스레드 순서·스레드 안 답변 순서). 개수·작성자 합계는 어떤 응답에도 싣지 않습니다.
 */

/** 질문·답변 본문 최대 길이(글자). */
export const STUCK_QA_BODY_MAX = 2000
/** 카드 목록의 질문 미리보기 길이. */
export const STUCK_QA_EXCERPT_MAX = 160
/** 카드 하나에 보여 줄 스레드 수 / 스레드 하나의 글 수 한도. */
export const STUCK_QA_THREAD_LIMIT = 50
export const STUCK_QA_POST_LIMIT = 200

export const STUCK_QA_POST_KINDS = ['question', 'answer'] as const
export type StuckQaPostKind = (typeof STUCK_QA_POST_KINDS)[number]

/** 글 상태: 게시 / 작성자가 지움(탈퇴 정리 포함, 본문을 비움) / 운영 조치로 숨김(hide_stuck_qa_post). */
export const STUCK_QA_POST_STATUSES = ['published', 'withdrawn', 'hidden'] as const
export type StuckQaPostStatus = (typeof STUCK_QA_POST_STATUSES)[number]

/** 질문자 번호. */
export const STUCK_QA_ASKER_ALIAS = 0
export const STUCK_QA_ASKER_LABEL = '질문자'
export const STUCK_QA_LOG_AUTHOR_LABEL = '작성자'

export interface StuckQaAliasRow {
  userId: string
  aliasNo: number
}

export type StuckQaAliasAssignment =
  /** 막힘 로그 작성자(번호 없음, `작성자`). */
  | { kind: 'log_author' }
  /** 이미 있는 번호를 다시 씀. */
  | { kind: 'existing'; aliasNo: number }
  /** 새 번호를 넣어야 함. */
  | { kind: 'new'; aliasNo: number }

/**
 * 이 스레드에서 이 사람이 이번 글에 쓸 표시.
 * - 막힘 로그 작성자면 번호 없이 `작성자`(익명을 골라도 같음 — §8.5 "신뢰도 유지").
 * - 이미 번호가 있으면 그 번호(같은 스레드 같은 사람 같은 번호).
 * - 스레드를 여는 질문이면 0(`질문자`).
 * - 그 밖에는 지금까지의 가장 큰 번호 + 1. 지운·숨긴 글의 번호도 남아 있으므로 다시 쓰이지 않습니다.
 * 같은 스레드에 동시에 쓰면 호출자가 스레드 행을 잠가 순서를 정합니다(unique(thread_id, alias_no)가 마지막 방어선).
 */
export function assignStuckQaAlias(input: {
  existing: readonly StuckQaAliasRow[]
  userId: string
  logAuthorId: string
  opensThread: boolean
}): StuckQaAliasAssignment {
  if (input.userId === input.logAuthorId) return { kind: 'log_author' }
  const mine = input.existing.find((a) => a.userId === input.userId)
  if (mine) return { kind: 'existing', aliasNo: mine.aliasNo }
  if (input.opensThread) return { kind: 'new', aliasNo: STUCK_QA_ASKER_ALIAS }
  const max = input.existing.reduce((m, a) => (a.aliasNo > m ? a.aliasNo : m), 0)
  return { kind: 'new', aliasNo: max + 1 }
}

export type StuckQaRole = 'asker' | 'log_author' | 'anonymous'

/** 글의 표시(번호 → `질문자`·`익명N`, 로그 작성자 → `작성자`). 이름·사람 id는 없습니다. */
export function stuckQaAuthorLabel(post: { byLogAuthor: boolean; aliasNo: number | null }): { role: StuckQaRole; label: string } {
  if (post.byLogAuthor) return { role: 'log_author', label: STUCK_QA_LOG_AUTHOR_LABEL }
  if (post.aliasNo === STUCK_QA_ASKER_ALIAS) return { role: 'asker', label: STUCK_QA_ASKER_LABEL }
  return { role: 'anonymous', label: post.aliasNo === null ? '익명' : `익명${post.aliasNo}` }
}

/**
 * 카드 안 스레드 순서: 게시 중인 답변이 받은 "도움됐어요" 합 많은 순 → 최근 글 순 → id. 개수는 정렬에만 쓰고 응답에 싣지 않습니다.
 */
export function rankStuckQaThreads<T extends { helped: number; lastPostAt: string; id: string }>(threads: readonly T[]): T[] {
  return [...threads].sort((a, b) => b.helped - a.helped || (a.lastPostAt < b.lastPostAt ? 1 : a.lastPostAt > b.lastPostAt ? -1 : 0) || (a.id < b.id ? -1 : 1))
}

/** 스레드 안 글 순서: 질문 먼저, 답변은 "도움됐어요" 많은 순 → 먼저 쓴 순 → id. */
export function rankStuckQaPosts<T extends { kind: StuckQaPostKind; helped: number; createdAt: string; id: string }>(posts: readonly T[]): T[] {
  return [...posts].sort(
    (a, b) =>
      (a.kind === 'question' ? 0 : 1) - (b.kind === 'question' ? 0 : 1) ||
      b.helped - a.helped ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  )
}

/** 글 본문 정규화(앞뒤 공백 제거, 줄바꿈 \n). 비었으면 null. */
export function normalizeStuckQaBody(raw: string): string | null {
  const body = raw.replace(/\r\n?/g, '\n').trim()
  return body.length === 0 ? null : body
}

/** 미리보기(공백을 한 칸으로, 길면 말줄임). */
export function stuckQaExcerpt(body: string, max = STUCK_QA_EXCERPT_MAX): string {
  const text = body.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
