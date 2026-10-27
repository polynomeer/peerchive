import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_TARGET,
  ANALYTICS_PROP_SPECS,
  COMMENT_BODY_MAX,
  POST_TITLE_MAX,
  type AuthorProfileBits,
  type CommunityViewer,
  type NameMode,
  type SpaceFacts,
  type ThreadAliasRow,
  aliasLabel,
  assignThreadAlias,
  canChangeOwnItem,
  canCommentOnBoard,
  canReact,
  canWriteBoard,
  checkItemBody,
  checkPostTitle,
  composerNameModeNote,
  itemPlaceholder,
  nameModeAtWrite,
  postNoticeText,
  reportTargetKey,
  resolveAuthorDisplay,
  sanitizeAnalyticsProps,
  sanitizeNoticePayload,
  sanitizePostNoticePayload,
  shouldBucketTimes,
  threadAuthorView,
  timeBucket,
} from '../src'

const SCHOOL = 'school-1'
const viewer = (over: Partial<CommunityViewer> = {}): CommunityViewer => ({
  userId: 'u-viewer',
  status: 'active',
  operator: false,
  affiliations: [{ schoolId: SCHOOL, departmentKey: '컴퓨터공학과' }],
  ...over,
})
const room = (over: Partial<SpaceFacts> = {}): SpaceFacts => ({
  kind: 'user_room',
  schoolId: null,
  departmentKey: null,
  discovery: 'listed',
  joinPolicy: 'open',
  status: 'active',
  capacity: 300,
  activeMembers: 5,
  ...over,
})
const official = (over: Partial<SpaceFacts> = {}): SpaceFacts => room({ kind: 'official_school', schoolId: SCHOOL, ...over })
const member = { role: 'member' as const, status: 'active' as const }
const moderator = { role: 'moderator' as const, status: 'active' as const }

/** 스레드 하나를 시뮬레이션: 글쓴이와 참여 순서대로 쓰면 각자의 번호. */
function simulateThread(postAuthor: string, postMode: NameMode, writes: Array<{ user: string; mode: NameMode }>): { aliases: ThreadAliasRow[]; labels: string[] } {
  const aliases: ThreadAliasRow[] = []
  const write = (user: string, mode: NameMode) => {
    const plan = assignThreadAlias({ existing: aliases, userId: user, postAuthorId: postAuthor, postNameMode: postMode, writeMode: mode })
    if (plan.insert) aliases.push({ userId: user, aliasNo: plan.aliasNo })
    return plan.aliasNo
  }
  write(postAuthor, postMode)
  const labels = writes.map((w) => {
    const no = write(w.user, w.mode)
    return w.mode === 'anonymous' ? aliasLabel(no) : `(${w.mode})`
  })
  return { aliases, labels }
}

describe('thread aliases (C-04, §8.5)', () => {
  it('anonymous post author is 글쓴이 everywhere in the thread; others get 익명1, 익명2 in order of first anonymous participation', () => {
    const { labels, aliases } = simulateThread('A', 'anonymous', [
      { user: 'B', mode: 'anonymous' },
      { user: 'A', mode: 'anonymous' },
      { user: 'C', mode: 'anonymous' },
      { user: 'B', mode: 'anonymous' },
      { user: 'D', mode: 'anonymous' },
      { user: 'C', mode: 'anonymous' },
    ])
    expect(labels).toEqual(['익명1', '글쓴이', '익명2', '익명1', '익명3', '익명2'])
    expect(aliases).toEqual([
      { userId: 'A', aliasNo: 0 },
      { userId: 'B', aliasNo: 1 },
      { userId: 'C', aliasNo: 2 },
      { userId: 'D', aliasNo: 3 },
    ])
  })

  it('numbers are per thread: the same people in another thread get numbers from that thread only', () => {
    const one = simulateThread('A', 'anonymous', [
      { user: 'B', mode: 'anonymous' },
      { user: 'C', mode: 'anonymous' },
    ])
    const two = simulateThread('C', 'anonymous', [
      { user: 'A', mode: 'anonymous' },
      { user: 'B', mode: 'anonymous' },
    ])
    expect(one.labels).toEqual(['익명1', '익명2'])
    expect(two.labels).toEqual(['익명1', '익명2'])
    // B는 첫 스레드에서 익명1, 둘째 스레드에서는 익명2: 번호로 같은 사람을 이을 수 없음
    expect(one.aliases.find((a) => a.userId === 'B')!.aliasNo).toBe(1)
    expect(two.aliases.find((a) => a.userId === 'B')!.aliasNo).toBe(2)
  })

  it('a deleted participant keeps their number (rows are never reused): the next newcomer gets max + 1', () => {
    const existing: ThreadAliasRow[] = [
      { userId: 'A', aliasNo: 0 },
      { userId: 'B', aliasNo: 1 },
      { userId: 'C', aliasNo: 2 },
    ]
    expect(assignThreadAlias({ existing, userId: 'E', postAuthorId: 'A', postNameMode: 'anonymous', writeMode: 'anonymous' })).toEqual({ aliasNo: 3, insert: true })
    expect(assignThreadAlias({ existing, userId: 'B', postAuthorId: 'A', postNameMode: 'anonymous', writeMode: 'anonymous' })).toEqual({ aliasNo: 1, insert: false })
  })

  it('named (display/real) writes get no number; a named post’s author is not 글쓴이 when commenting anonymously later', () => {
    // 표시명 글 → 공간이 익명으로 바뀐 뒤: 글쓴이도 다른 사람처럼 번호를 받음(이름이 보이는 글과 이어지지 않게)
    const { labels } = simulateThread('A', 'display', [
      { user: 'B', mode: 'display' },
      { user: 'B', mode: 'anonymous' },
      { user: 'A', mode: 'anonymous' },
    ])
    expect(labels).toEqual(['(display)', '익명1', '익명2'])
    expect(assignThreadAlias({ existing: [], userId: 'A', postAuthorId: 'A', postNameMode: 'real', writeMode: 'real' })).toEqual({ aliasNo: null, insert: false })
  })

  it('labels: 0 → 글쓴이, n → 익명n, unknown → 익명', () => {
    expect([aliasLabel(0), aliasLabel(1), aliasLabel(12), aliasLabel(null)]).toEqual(['글쓴이', '익명1', '익명12', '익명'])
  })
})

describe('author view (resolveAuthorDisplay + thread alias)', () => {
  const author: AuthorProfileBits = { userId: 'A', status: 'active', purged: false, displayName: '지민', realName: '김지민', schoolVerified: true }

  it('anonymous items carry only the thread label; moderators/owners/operators see the same; mine only for the author', () => {
    const forOwner = threadAuthorView(resolveAuthorDisplay('anonymous', author, { userId: 'owner' }), 2, true)
    const forOperator = threadAuthorView(resolveAuthorDisplay('anonymous', author, null), 2, true)
    expect(forOwner).toEqual({ kind: 'anonymous', label: '익명2', schoolVerified: false, mine: false })
    expect(forOperator).toEqual(forOwner)
    expect(JSON.stringify(forOwner)).not.toMatch(/지민|김지민|"A"/)
    expect(threadAuthorView(resolveAuthorDisplay('anonymous', author, { userId: 'A' }), 0, true)).toEqual({ kind: 'anonymous', label: '글쓴이', schoolVerified: false, mine: true })
  })

  it('display/real items show the name (real + school-verified flag); tombstones drop the name but keep anonymous numbers', () => {
    expect(threadAuthorView(resolveAuthorDisplay('display', author, null), null, true)).toEqual({ kind: 'display', label: '지민', schoolVerified: false, mine: false })
    expect(threadAuthorView(resolveAuthorDisplay('real', author, null), null, true)).toEqual({ kind: 'real', label: '김지민', schoolVerified: true, mine: false })
    expect(threadAuthorView(resolveAuthorDisplay('display', author, null), null, false).label).toBeNull()
    expect(threadAuthorView(resolveAuthorDisplay('real', author, null), null, false)).toMatchObject({ label: null, schoolVerified: false })
    expect(threadAuthorView(resolveAuthorDisplay('anonymous', author, null), 3, false).label).toBe('익명3')
  })

  it('purged authors: named items show 탈퇴한 사용자, anonymous items keep the thread label (withdrawal not revealed)', () => {
    const gone = { ...author, purged: true, status: 'deleted' as const }
    expect(threadAuthorView(resolveAuthorDisplay('display', gone, null), null, false)).toMatchObject({ kind: 'withdrawn', label: '탈퇴한 사용자' })
    expect(threadAuthorView(resolveAuthorDisplay('anonymous', gone, null), 1, false)).toMatchObject({ kind: 'anonymous', label: '익명1' })
  })

  it('placeholders for deleted and hidden items', () => {
    expect(itemPlaceholder('post', 'published')).toBeNull()
    expect(itemPlaceholder('post', 'deleted_by_author')).toBe('작성자가 삭제한 글입니다')
    expect(itemPlaceholder('post', 'hidden')).toBe('운영 조치로 가려진 글입니다')
    expect(itemPlaceholder('comment', 'auto_hidden')).toBe('운영 조치로 가려진 댓글입니다')
  })
})

describe('write-time contract and permissions (ADR 0020, C-04)', () => {
  it('official pages default anonymous, allow display per post, reject real; rooms take the space mode only', () => {
    const o = { kind: 'official_school' as const, currentNameMode: 'anonymous' as const }
    expect(nameModeAtWrite(o, new Date())).toEqual({ ok: true, mode: 'anonymous' })
    expect(nameModeAtWrite(o, new Date(), 'display')).toEqual({ ok: true, mode: 'display' })
    expect(nameModeAtWrite(o, new Date(), 'real')).toEqual({ ok: false, reason: 'real_not_allowed' })
    expect(nameModeAtWrite({ kind: 'user_room', currentNameMode: 'real' }, new Date(), 'anonymous')).toEqual({ ok: false, reason: 'mode_fixed' })
  })

  it('notice boards: only moderators post, but members comment; non-members cannot comment; archived spaces are read-only', () => {
    const notice = { kind: 'notice' as const, writeRole: 'moderator' as const }
    expect(canWriteBoard(viewer(), room(), member, notice)).toBe(false)
    expect(canWriteBoard(viewer(), room(), moderator, notice)).toBe(true)
    expect(canCommentOnBoard(viewer(), room(), member, notice)).toBe(true)
    expect(canCommentOnBoard(viewer(), room(), null, notice)).toBe(false)
    expect(canCommentOnBoard(viewer(), room({ status: 'archived' }), member, { kind: 'general', writeRole: 'member' })).toBe(false)
    // 공식 학과 페이지 댓글도 같은 학과만
    const dept = room({ kind: 'official_department', schoolId: SCHOOL, departmentKey: '경영학과' })
    expect(canCommentOnBoard(viewer(), dept, null, { kind: 'free', writeRole: 'member' })).toBe(false)
    expect(canCommentOnBoard(viewer({ affiliations: [{ schoolId: SCHOOL, departmentKey: '경영학과' }] }), dept, null, { kind: 'free', writeRole: 'member' })).toBe(true)
  })

  it('reactions need read access to an active space and no suspension; write role does not matter', () => {
    expect(canReact(viewer(), official(), null)).toBe(true)
    expect(canReact(viewer({ affiliations: [] }), official(), null)).toBe(false)
    expect(canReact(viewer(), room(), null)).toBe(false)
    expect(canReact(viewer({ communityWriteSuspended: true }), room(), member)).toBe(false)
    expect(canReact(viewer(), room({ status: 'restricted' }), member)).toBe(false)
  })

  it('own-item changes: author only, open items only for edit, delete also works on hidden items', () => {
    const item = { authorId: 'me', status: 'published' as const }
    expect(canChangeOwnItem(item, 'other', 'active', 'edit')).toBe('not_author')
    expect(canChangeOwnItem(item, 'me', 'active', 'edit')).toBe('ok')
    expect(canChangeOwnItem({ ...item, status: 'hidden' }, 'me', 'active', 'edit')).toBe('not_open')
    expect(canChangeOwnItem({ ...item, status: 'hidden' }, 'me', 'active', 'delete')).toBe('ok')
    expect(canChangeOwnItem({ ...item, status: 'deleted_by_author' }, 'me', 'active', 'delete')).toBe('not_open')
    expect(canChangeOwnItem(item, 'me', 'archived', 'edit')).toBe('space_not_active')
  })

  it('text checks: title 120 (spaces collapsed), body max, control characters rejected', () => {
    expect(checkPostTitle('  안녕   하세요 ')).toEqual({ ok: true, value: '안녕 하세요' })
    expect(checkPostTitle('가'.repeat(POST_TITLE_MAX + 1))).toEqual({ ok: false, reason: 'too_long' })
    expect(checkPostTitle('   ')).toEqual({ ok: false, reason: 'required' })
    expect(checkItemBody('줄1\r\n줄2', COMMENT_BODY_MAX)).toEqual({ ok: true, value: '줄1\n줄2' })
    expect(checkItemBody('a\u0000b', COMMENT_BODY_MAX)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkItemBody('가'.repeat(COMMENT_BODY_MAX + 1), COMMENT_BODY_MAX)).toEqual({ ok: false, reason: 'too_long' })
  })

  it('composer notes always state the mode', () => {
    expect(composerNameModeNote('user_room', 'anonymous')).toBe('이 방은 익명으로 표시됩니다.')
    expect(composerNameModeNote('official_school', 'anonymous')).toContain('실명은 쓸 수 없음')
  })
})

describe('small anonymous rooms: time buckets (SYSTEM_DESIGN §6.7, §5.1 P)', () => {
  const now = new Date('2026-11-10T03:00:00Z') // 서울 12:00
  it('only anonymous items in rooms under 10 active members', () => {
    expect(shouldBucketTimes({ kind: 'user_room', activeMembers: 9 }, 'anonymous')).toBe(true)
    expect(shouldBucketTimes({ kind: 'user_room', activeMembers: 10 }, 'anonymous')).toBe(false)
    expect(shouldBucketTimes({ kind: 'user_room', activeMembers: 3 }, 'display')).toBe(false)
    expect(shouldBucketTimes({ kind: 'official_school', activeMembers: 0 }, 'anonymous')).toBe(false)
  })
  it('today (Seoul date) / this week / earlier', () => {
    expect(timeBucket(new Date('2026-11-09T15:30:00Z'), now)).toBe('today') // 서울 11-10 00:30
    expect(timeBucket(new Date('2026-11-09T14:30:00Z'), now)).toBe('this_week') // 서울 11-09 23:30
    expect(timeBucket(new Date('2026-11-02T03:00:00Z'), now)).toBe('earlier')
  })
})

describe('allowlists (C-04)', () => {
  it('post_commented notices carry a count only', () => {
    expect(sanitizePostNoticePayload({ count: 3 })).toEqual({ count: 3 })
    expect(sanitizePostNoticePayload({ count: 3, commenter: 'x' })).toBeNull()
    expect(sanitizePostNoticePayload({ count: 0 })).toBeNull()
    expect(sanitizeNoticePayload('post_commented', { count: 1 })).toBeNull()
    expect(postNoticeText({ count: 2 })).toBe('내 글에 새 댓글이 2개 달렸습니다.')
  })

  it('analytics events: board kind, mode, reply, target only — no ids or text', () => {
    expect(sanitizeAnalyticsProps('post_created', { kind: 'free', mode: 'anonymous' })).toEqual({ ok: true, props: { kind: 'free', mode: 'anonymous' } })
    expect(sanitizeAnalyticsProps('comment_created', { mode: 'display', reply: true }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('reaction_added', { target: 'comment' }).ok).toBe(true)
    for (const leak of [{ postId: 'x' }, { title: '제목' }, { kind: '자유 글' }, { mode: 'downvote' }]) expect(sanitizeAnalyticsProps('post_created', leak).ok).toBe(false)
    expect(Object.keys(ANALYTICS_PROP_SPECS.reaction_added)).toEqual(['target'])
  })

  it('moderation: posts and comments can only be hidden (block, not delete)', () => {
    expect(ACTIONS_BY_TARGET.community_post).toEqual(['none', 'hide_post'])
    expect(ACTIONS_BY_TARGET.community_comment).toEqual(['none', 'hide_comment'])
    expect(reportTargetKey({ type: 'community_post', postId: 'p1' })).toBe('community_post:p1')
  })
})
