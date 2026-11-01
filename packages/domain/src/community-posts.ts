/**
 * 커뮤니티 글·댓글·공감·스레드 익명 번호 (C-04, PROOFU_EVOLUTION_PLAN §8.5 "스레드 단위 익명 표시"·§8.9.1·§8.9.6·§8.9.7,
 * SYSTEM_DESIGN §6.7 Post·Comment·ThreadAlias·Reaction·"소규모 익명 방"·§8.1·§9.1, DELIVERY_PLAN §4.1 C-04·§5.1 K·P, ADR 0020·0022).
 *
 * - 글·댓글의 이름 표시 방식은 쓰는 순간 `nameModeAtWrite`(name-modes.ts)로 정해 고정합니다(ADR 0020 계약). 여기서는 고정된 방식으로
 *   스레드 안의 작성자 표시를 만듭니다.
 * - **스레드 익명 번호(ThreadAlias)**: 번호는 글(스레드)마다 따로이며 사람(user)마다 하나입니다. 익명으로 쓸 때만 받습니다.
 *   - 익명 글의 글쓴이는 0번(`글쓴이`). 그 스레드에서 글쓴이가 익명으로 쓴 댓글도 `글쓴이`.
 *   - 다른 사람은 그 스레드에 **처음 익명으로 쓴 순서대로** 1, 2, …(`익명1`·`익명2`). 같은 사람은 같은 번호를 유지하고, 지워도 번호를 다시 쓰지 않습니다.
 *   - 글이 익명이 아니면(표시명·실명 글) 글쓴이도 `글쓴이` 표시를 받지 않고 다른 사람처럼 번호를 받습니다. 이름이 보이는 글의 글쓴이를
 *     `글쓴이`로 묶으면 익명 댓글이 그 이름과 이어지기 때문입니다. 같은 이유로 표시명·실명 글·댓글에는 번호를 주지 않습니다(이름이 보이는
 *     참여 순서로 익명 번호를 추정하지 못하게).
 *   - 스레드 사이에는 번호·키를 공유하지 않습니다. 응답에는 사람 id·별칭 행 id가 없고, 번호는 그 스레드 안에서만 뜻이 있습니다.
 * - 보는 사람이 방장·모더레이터·운영자여도 표시가 같습니다. `mine`은 보는 사람 자신의 글에만 true입니다.
 * - 공감(empathy)만 있고 비추천은 없습니다(§8.9.7). 개수만 보여 주고 누가 눌렀는지는 보여 주지 않습니다.
 *
 * 런타임 의존성 없음.
 */
import {
  type BoardFacts,
  type CommunityViewer,
  type MembershipFacts,
  type NameMode,
  type SpaceFacts,
  type SpaceKind,
  canReadSpace,
  canWriteBoard,
  isAnonymousMode,
  isOfficialKind,
  isOperatorSpaceKind,
} from './community'
import type { AuthorDisplay } from './name-modes'

export const POST_TITLE_MAX = 120
export const POST_BODY_MAX = 10_000
export const COMMENT_BODY_MAX = 3_000

/** 글·댓글 상태. published 외에는 본문을 보여 주지 않고 자리 표시 글만 보여 줍니다. auto_hidden은 신고 누적 임시 숨김(C-06, 운영 검토 중)입니다. */
export const COMMUNITY_ITEM_STATUSES = ['published', 'deleted_by_author', 'hidden', 'auto_hidden'] as const
export type CommunityItemStatus = (typeof COMMUNITY_ITEM_STATUSES)[number]

/** 공감만(§8.9.1 "공감만 두고 비추천은 두지 않음"). */
export const REACTION_KINDS = ['empathy'] as const
export type ReactionKind = (typeof REACTION_KINDS)[number]

/** 사용자별 쓰기 한도: 글 시간당 10개, 댓글 시간당 60개. */
export const POST_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const
export const COMMENT_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const
/** 요청 본문 상한(바이트). 글자 수 상한(본문 10000자 × UTF-8 최대 3바이트)보다 넉넉하고, 큰 본문을 파싱하기 전에 끊습니다. */
export const COMMUNITY_WRITE_BODY_BYTES = 64 * 1024
/** 글 목록 한 쪽. */
export const POST_PAGE_SIZE = 20
/** 한 스레드에서 한 번에 보여 주는 댓글 수 상한. */
export const THREAD_COMMENT_LIMIT = 1000

/** 익명 글의 글쓴이 번호. */
export const POST_AUTHOR_ALIAS = 0
export const POST_AUTHOR_LABEL = '글쓴이'

export const POST_PLACEHOLDERS: Readonly<Record<Exclude<CommunityItemStatus, 'published'>, string>> = {
  deleted_by_author: '작성자가 삭제한 글입니다',
  hidden: '운영 조치로 가려진 글입니다',
  auto_hidden: '신고가 모여 운영 검토 중인 글입니다',
}
export const COMMENT_PLACEHOLDERS: Readonly<Record<Exclude<CommunityItemStatus, 'published'>, string>> = {
  deleted_by_author: '작성자가 삭제한 댓글입니다',
  hidden: '운영 조치로 가려진 댓글입니다',
  auto_hidden: '신고가 모여 운영 검토 중인 댓글입니다',
}

export function isOpenItem(status: CommunityItemStatus): boolean {
  return status === 'published'
}

/** 자리 표시 글(published면 null). */
export function itemPlaceholder(target: 'post' | 'comment', status: CommunityItemStatus): string | null {
  if (status === 'published') return null
  return (target === 'post' ? POST_PLACEHOLDERS : COMMENT_PLACEHOLDERS)[status]
}

// ── 스레드 익명 번호 ─────────────────────────────────────────────────────

export interface ThreadAliasRow {
  userId: string
  aliasNo: number
}

export type AliasAssignment =
  /** 번호가 필요 없음(익명이 아닌 글·댓글). */
  | { aliasNo: null; insert: false }
  /** 이미 있는 번호를 다시 씀. */
  | { aliasNo: number; insert: false }
  /** 새 번호를 넣어야 함. */
  | { aliasNo: number; insert: true }

/**
 * 이 스레드에서 이 사람이 이번 글·댓글에 쓸 익명 번호.
 * - 쓰는 방식이 익명이 아니면 번호 없음(넣지도 않음).
 * - 이미 번호가 있으면 그 번호.
 * - 익명 글의 글쓴이는 0(`글쓴이`).
 * - 그 밖에는 지금까지의 가장 큰 번호 + 1(0은 세지 않음). 지운 글·댓글의 번호도 남아 있으므로 다시 쓰이지 않습니다.
 * 같은 스레드에 동시에 쓰면 호출자가 글 행을 잠가 순서를 정합니다(unique(post_id, alias_no)가 마지막 방어선).
 */
export function assignThreadAlias(input: {
  existing: readonly ThreadAliasRow[]
  userId: string
  postAuthorId: string
  postNameMode: NameMode
  writeMode: NameMode
}): AliasAssignment {
  // 소속 표시 익명(A-05)도 익명과 같은 번호를 씁니다(소속 표시는 번호 옆에 붙음, SYSTEM_DESIGN §6.7.2).
  if (!isAnonymousMode(input.writeMode)) return { aliasNo: null, insert: false }
  const mine = input.existing.find((a) => a.userId === input.userId)
  if (mine) return { aliasNo: mine.aliasNo, insert: false }
  if (input.userId === input.postAuthorId && isAnonymousMode(input.postNameMode)) return { aliasNo: POST_AUTHOR_ALIAS, insert: true }
  const max = input.existing.reduce((m, a) => (a.aliasNo > m ? a.aliasNo : m), 0)
  return { aliasNo: max + 1, insert: true }
}

/** 익명 번호 → 표시(0 `글쓴이`, n `익명n`). 번호를 모르면(있어서는 안 됨) `익명`. */
export function aliasLabel(aliasNo: number | null | undefined): string {
  if (aliasNo === null || aliasNo === undefined) return '익명'
  return aliasNo === POST_AUTHOR_ALIAS ? POST_AUTHOR_LABEL : `익명${aliasNo}`
}

/** 화면·API의 작성자 표시. 사람 id·핸들·프로필 링크·별칭 행 id가 없습니다. */
export interface ThreadAuthorView {
  kind: 'real' | 'display' | 'anonymous' | 'withdrawn'
  /** 이름·`글쓴이`·`익명N`·`탈퇴한 사용자`. 지우거나 가린 표시명·실명 글은 null(이름을 남기지 않음). */
  label: string | null
  /** 실명 글이고 학교를 연결한 공간에서 그 학교 인증이 있는지. */
  schoolVerified: boolean
  /** 보는 사람 자신의 글인지(그 사람의 응답에만 true). */
  mine: boolean
}

/**
 * resolveAuthorDisplay 결과 + 스레드 익명 번호 → 표시. 지우거나 가린 글(open이 아님)은:
 * 익명은 번호를 그대로(스레드 안 번호가 이어지게), 탈퇴는 `탈퇴한 사용자`, 표시명·실명은 이름 없이(null).
 */
export function threadAuthorView(display: AuthorDisplay, aliasNo: number | null | undefined, open: boolean): ThreadAuthorView {
  switch (display.kind) {
    case 'anonymous':
      return { kind: 'anonymous', label: aliasLabel(aliasNo), schoolVerified: false, mine: display.mine }
    case 'withdrawn':
      return { kind: 'withdrawn', label: display.label, schoolVerified: false, mine: false }
    case 'real':
      return { kind: 'real', label: open ? display.label : null, schoolVerified: open && display.schoolVerified, mine: display.mine }
    case 'display':
      return { kind: 'display', label: open ? display.label : null, schoolVerified: false, mine: display.mine }
  }
}

// ── 시각 표시(소규모 익명 방) ─────────────────────────────────────────────

/** 이 수보다 active 멤버가 적은 사용자 방·스터디 방의 익명 글·댓글은 시각을 버킷으로만 보여 줍니다(SYSTEM_DESIGN §6.7 "소규모 익명 방", §5.1 P). */
export const SMALL_ROOM_MEMBER_THRESHOLD = 10
export type CommunityTimeBucket = 'today' | 'this_week' | 'earlier'
export const COMMUNITY_TIME_BUCKET_LABELS: Readonly<Record<CommunityTimeBucket, string>> = { today: '오늘', this_week: '이번 주', earlier: '일주일 전 이전' }

/**
 * 시각을 감춰야 하는지: 운영자가 연 공간(공식 페이지·토픽 — 멤버 수를 세지 않는 넓은 공간)이 아니고, 익명 글·댓글이고, 지금 active 멤버가 10명 미만.
 * DB에는 정확한 시각이 남습니다.
 */
export function shouldBucketTimes(space: { kind: SpaceKind; activeMembers: number }, itemMode: NameMode): boolean {
  return !isOperatorSpaceKind(space.kind) && isAnonymousMode(itemMode) && space.activeMembers < SMALL_ROOM_MEMBER_THRESHOLD
}

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** 서울 날짜가 같으면 today, 7일 안이면 this_week, 그보다 전이면 earlier. 미래 시각(시계 차)은 today. */
export function timeBucket(at: Date, now: Date): CommunityTimeBucket {
  const day = (d: Date) => Math.floor((d.getTime() + SEOUL_OFFSET_MS) / DAY_MS)
  if (day(at) >= day(now)) return 'today'
  return now.getTime() - at.getTime() < 7 * DAY_MS ? 'this_week' : 'earlier'
}

// ── 권한 ─────────────────────────────────────────────────────────────────

/**
 * 댓글을 쓸 자격: 그 공간에 글을 쓸 수 있는 사람(멤버 수준 쓰기 자격). 공지처럼 운영진만 글을 쓰는 게시판에도 멤버가 댓글을 씁니다.
 * 공식 학과 페이지는 같은 학과 키, 공식 학교 페이지는 그 학교 인증(학과 쓰기 제한 removed가 없을 것), 사용자 방은 active 멤버.
 */
export function canCommentOnBoard(
  viewer: CommunityViewer | null | undefined,
  space: SpaceFacts,
  membership: MembershipFacts | null | undefined,
  board: BoardFacts,
): boolean {
  const memberLevel: BoardFacts = { kind: board.kind === 'notice' ? 'free' : board.kind, writeRole: 'member' }
  return canWriteBoard(viewer, space, membership, memberLevel)
}

/** 공감할 수 있는지: active 공간을 읽을 수 있고 이 공간에 쓰기 제한(C-06 제재)이 없을 것. 쓰기 역할과는 무관합니다. */
export function canReact(viewer: CommunityViewer | null | undefined, space: SpaceFacts, membership: MembershipFacts | null | undefined): boolean {
  if (!viewer || viewer.status !== 'active' || space.status !== 'active') return false
  if (viewer.communityWriteSuspended) return false
  return canReadSpace(viewer, space, membership)
}

/** 본인 글·댓글을 고치거나 지울 수 있는지. 지우기는 가린 글에도 됩니다(운영 조치 뒤 스스로 지우기). */
export function canChangeOwnItem(
  item: { authorId: string; status: CommunityItemStatus },
  viewerId: string,
  spaceStatus: SpaceFacts['status'],
  action: 'edit' | 'delete',
): 'ok' | 'not_author' | 'not_open' | 'space_not_active' {
  if (item.authorId !== viewerId) return 'not_author'
  if (item.status === 'deleted_by_author') return 'not_open'
  if (action === 'edit' && item.status !== 'published') return 'not_open'
  if (spaceStatus !== 'active') return 'space_not_active'
  return 'ok'
}

// ── 입력 ─────────────────────────────────────────────────────────────────

export type TextCheck = { ok: true; value: string } | { ok: false; reason: 'required' | 'too_long' | 'invalid' }

/** 제목: NFC·공백 하나로·앞뒤 공백 제거, 1~120자, 제어 문자 없음. */
export function checkPostTitle(raw: unknown): TextCheck {
  if (typeof raw !== 'string') return { ok: false, reason: raw === undefined || raw === null ? 'required' : 'invalid' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!value) return { ok: false, reason: 'required' }
  if ([...value].length > POST_TITLE_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

/** 본문: NFC·줄바꿈 정리(\r\n → \n)·앞뒤 공백 제거, 1~max자, 탭·줄바꿈 외 제어 문자 없음. */
export function checkItemBody(raw: unknown, max: number): TextCheck {
  if (typeof raw !== 'string') return { ok: false, reason: raw === undefined || raw === null ? 'required' : 'invalid' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (!value) return { ok: false, reason: 'required' }
  if ([...value].length > max) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

// ── 글쓰기 화면 안내 ─────────────────────────────────────────────────────

/**
 * 글쓰기 화면에 항상 보일 이름 표시 안내(§9.1 "글쓰기 화면이 항상 표시할 current_name_mode"). 사용자 방은 공간 방식, 공식 페이지는 선택.
 * 익명이면 "운영자는 신고 처리를 위해 작성자를 확인할 수 있고, 방장·모더레이터는 확인할 수 없음"을 함께 알립니다(§8.9.6).
 */
export function composerNameModeNote(kind: SpaceKind, mode: NameMode): string {
  if (kind === 'topic') return '토픽의 글은 이름 없이 소속과 신분만 보입니다(예: ○○대 · 졸업생). 표시할 범위를 고르거나 표시하지 않을 수 있습니다.'
  if (isOfficialKind(kind)) return '공식 페이지의 글은 익명이 기본이고, 글마다 표시명을 고를 수 있습니다(실명은 쓸 수 없음).'
  if (mode === 'anonymous') return '이 방은 익명으로 표시됩니다.'
  if (mode === 'display') return '이 방은 표시명으로 표시됩니다.'
  return '이 방은 실명으로 표시됩니다.'
}

export const ANONYMITY_OPERATOR_NOTE =
  '익명은 다른 사용자에게 익명이라는 뜻입니다. 방장·모더레이터는 작성자를 볼 수 없고, 운영자는 신고 처리·법적 요청 대응을 위해 사유를 기록한 경우에만 작성자를 확인할 수 있습니다.'

// ── 알림(새 댓글) ────────────────────────────────────────────────────────

export interface PostCommentedNoticePayload {
  /** 읽기 전까지 모인 새 댓글 수(1~999). 댓글 쓴 사람·내용은 넣지 않습니다. */
  count: number
}

/** 새 댓글 알림 payload 허용 목록: count만. 다른 키·틀린 값이면 null. */
export function sanitizePostNoticePayload(raw: Readonly<Record<string, unknown>>): PostCommentedNoticePayload | null {
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'count') return null
  const count = raw.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 999) return null
  return { count }
}

export function postNoticeText(payload: PostCommentedNoticePayload): string {
  return payload.count > 1 ? `내 글에 새 댓글이 ${payload.count}개 달렸습니다.` : '내 글에 새 댓글이 달렸습니다.'
}

