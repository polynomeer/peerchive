/**
 * C-09 도메인 규칙(ADR 0025): 시작 조건, 필요한 동의, 해시 입력(동의가 묶이는 값), 동의 판정(해시가 다르면 stale), 복사본 이름,
 * 만료, 점검 항목, 알림 payload 허용 목록, 검색 문서, 신고 대상, 분석 허용 목록.
 */
import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_TARGET,
  ANALYTICS_PROP_SPECS,
  ARCHIVE_TRANSFER_TTL_MS,
  COURSE_QA_ANONYMOUS_LABELS,
  archiveDisplayLabel,
  archiveHashInput,
  archiveNoticeText,
  canStartTransfer,
  canonicalJson,
  courseQaCheckItems,
  evaluateConsents,
  isTransferExpired,
  reportTargetKey,
  requiredConsents,
  runPublicationChecks,
  sanitizeAnalyticsProps,
  sanitizeArchiveNoticePayload,
  searchDocFromCourseQa,
  type TransferSourceFacts,
} from '../src'

const base: TransferSourceFacts = {
  target: 'course_qa',
  actorId: 'asker',
  boardKind: 'question',
  post: { authorId: 'asker', open: true },
  accepted: { authorId: 'answerer', open: true },
  includeAnswer: true,
}

describe('canStartTransfer', () => {
  it('allows the question author to move a question with an open accepted answer', () => {
    expect(canStartTransfer(base)).toEqual({ ok: true })
  })

  it('refuses non-authors, closed sources, other boards and missing answers', () => {
    expect(canStartTransfer({ ...base, actorId: 'someone' })).toEqual({ ok: false, reason: 'not_author' })
    expect(canStartTransfer({ ...base, post: { authorId: 'asker', open: false } })).toEqual({ ok: false, reason: 'source_not_open' })
    expect(canStartTransfer({ ...base, boardKind: 'free' })).toEqual({ ok: false, reason: 'not_question_board' })
    expect(canStartTransfer({ ...base, accepted: null })).toEqual({ ok: false, reason: 'no_accepted_answer' })
    // 가려진·지워진 답변(운영 조치·임시 숨김)은 옮길 수 없음
    expect(canStartTransfer({ ...base, accepted: { authorId: 'answerer', open: false } })).toEqual({ ok: false, reason: 'no_accepted_answer' })
  })

  it('stuck_log needs an accepted answer only when the answer is included', () => {
    expect(canStartTransfer({ ...base, target: 'stuck_log', accepted: null, includeAnswer: false })).toEqual({ ok: true })
    expect(canStartTransfer({ ...base, target: 'stuck_log', accepted: null, includeAnswer: true })).toEqual({ ok: false, reason: 'no_accepted_answer' })
    expect(canStartTransfer({ ...base, target: 'stuck_log', boardKind: 'info', includeAnswer: false })).toEqual({ ok: false, reason: 'not_question_board' })
  })

  it('senior_note works from any board but only for the author', () => {
    expect(canStartTransfer({ ...base, target: 'senior_note', boardKind: 'free', accepted: null, includeAnswer: false })).toEqual({ ok: true })
    expect(canStartTransfer({ ...base, target: 'senior_note', actorId: 'x', boardKind: 'free' })).toEqual({ ok: false, reason: 'not_author' })
  })
})

describe('requiredConsents', () => {
  it('course_qa needs the asker and the answerer, once if they are the same person', () => {
    expect(requiredConsents({ target: 'course_qa', askerId: 'a', answererId: 'b', includeAnswer: true })).toEqual([
      { role: 'asker', userId: 'a' },
      { role: 'answerer', userId: 'b' },
    ])
    expect(requiredConsents({ target: 'course_qa', askerId: 'a', answererId: 'a', includeAnswer: true })).toEqual([{ role: 'asker', userId: 'a' }])
  })

  it('stuck_log needs the answerer only when the answer text is copied', () => {
    expect(requiredConsents({ target: 'stuck_log', askerId: 'a', answererId: 'b', includeAnswer: false })).toEqual([{ role: 'asker', userId: 'a' }])
    expect(requiredConsents({ target: 'stuck_log', askerId: 'a', answererId: 'b', includeAnswer: true })).toHaveLength(2)
  })

  it('senior_note needs only the author (the request is the consent)', () => {
    expect(requiredConsents({ target: 'senior_note', askerId: 'a', answererId: null, includeAnswer: false })).toEqual([{ role: 'author', userId: 'a' }])
  })
})

describe('hash binding', () => {
  const snapshot = { questionTitle: '포크 오류', questionBody: '자식이 안 끝나요', answerBody: 'waitpid를 보세요' }
  const input = { target: 'course_qa' as const, courseId: 'c1', snapshot, askerLabel: '질문한 학생' }

  it('the hashed value changes with any copied character, the course or the asker label (and is canonical)', () => {
    const a = canonicalJson(archiveHashInput(input))
    expect(canonicalJson(archiveHashInput({ ...input }))).toBe(a)
    expect(canonicalJson(archiveHashInput({ ...input, snapshot: { ...snapshot, answerBody: 'waitpid를 보세요!' } }))).not.toBe(a)
    expect(canonicalJson(archiveHashInput({ ...input, courseId: 'c2' }))).not.toBe(a)
    expect(canonicalJson(archiveHashInput({ ...input, askerLabel: '김학생' }))).not.toBe(a)
    // 프로젝트 id 같은 질문한 사람의 비공개 정보는 해시 입력에 없음(답한 사람에게 보여 줄 값만)
    expect(Object.keys(archiveHashInput(input)).sort()).toEqual(['answerBody', 'askerLabel', 'courseId', 'questionBody', 'questionTitle', 'target', 'v'])
  })

  it('evaluates consents: complete only when everyone granted the same hash', () => {
    expect(evaluateConsents([], 'h')).toBe('pending')
    expect(evaluateConsents([{ status: 'granted', contentHash: 'h' }, { status: 'pending', contentHash: null }], 'h')).toBe('pending')
    expect(evaluateConsents([{ status: 'granted', contentHash: 'h' }, { status: 'granted', contentHash: 'h' }], 'h')).toBe('complete')
    expect(evaluateConsents([{ status: 'granted', contentHash: 'h' }, { status: 'granted', contentHash: 'old' }], 'h')).toBe('stale')
    expect(evaluateConsents([{ status: 'granted', contentHash: 'h' }, { status: 'declined', contentHash: null }], 'h')).toBe('declined')
  })

  it('expires only awaiting requests after 14 days', () => {
    const t0 = new Date('2026-11-01T00:00:00Z')
    const expiresAt = new Date(t0.getTime() + ARCHIVE_TRANSFER_TTL_MS)
    expect(isTransferExpired({ status: 'awaiting_consent', expiresAt }, new Date(expiresAt.getTime() - 1))).toBe(false)
    expect(isTransferExpired({ status: 'awaiting_consent', expiresAt }, expiresAt)).toBe(true)
    expect(isTransferExpired({ status: 'done', expiresAt }, new Date(expiresAt.getTime() + 1))).toBe(false)
  })
})

describe('display options', () => {
  const names = { displayName: '  코딩하는 곰  ', realName: null }
  it('anonymous uses the role label; display uses the account display name; real needs a real name', () => {
    expect(archiveDisplayLabel('asker', 'anonymous', names)).toEqual({ ok: true, label: COURSE_QA_ANONYMOUS_LABELS.asker, anonymous: true })
    expect(archiveDisplayLabel('answerer', 'anonymous', names)).toEqual({ ok: true, label: '답한 학생', anonymous: true })
    expect(archiveDisplayLabel('asker', 'display', names)).toEqual({ ok: true, label: '코딩하는 곰', anonymous: false })
    expect(archiveDisplayLabel('asker', 'real', names)).toEqual({ ok: false, reason: 'real_name_required' })
    expect(archiveDisplayLabel('asker', 'real', { displayName: 'x', realName: '홍길동' })).toEqual({ ok: true, label: '홍길동', anonymous: false })
    expect(archiveDisplayLabel('asker', 'display', { displayName: ' ', realName: null })).toEqual({ ok: false, reason: 'display_name_missing' })
    const long = archiveDisplayLabel('asker', 'display', { displayName: '가'.repeat(60), realName: null })
    expect(long.ok && [...long.label].length).toBe(40)
  })
})

describe('checks, notices, search, reports, analytics', () => {
  it('runs publication checks on every copied field (both parties see the same warnings)', () => {
    const items = courseQaCheckItems({ questionTitle: '질문', questionBody: '연락 010-1234-5678', answerBody: 'me@school.ac.kr 로 메일' })
    expect(items.map((i) => i.location.field)).toEqual(['questionTitle', 'questionBody', 'answerBody'])
    const rules = runPublicationChecks(items).map((w) => `${w.rule}:${w.location.field}`)
    expect(rules).toEqual(expect.arrayContaining(['phone:questionBody', 'email:answerBody']))
    expect(courseQaCheckItems({ questionTitle: 'q', questionBody: 'b', answerBody: null })).toHaveLength(2)
  })

  it('notice payload carries the target kind only', () => {
    expect(sanitizeArchiveNoticePayload({ target: 'course_qa' })).toEqual({ target: 'course_qa' })
    expect(sanitizeArchiveNoticePayload({ target: 'course_qa', postId: 'x' })).toBeNull()
    expect(sanitizeArchiveNoticePayload({ target: 'nope' })).toBeNull()
    expect(archiveNoticeText('archive_consent_requested', { target: 'course_qa' })).toContain('동의')
  })

  it('search documents index only the copied text (no names)', () => {
    const doc = searchDocFromCourseQa({ questionTitle: 'Fork 오류', questionBody: '자식   프로세스', answerBody: 'WaitPid' })
    expect(doc.title).toBe('Fork 오류')
    expect(doc.searchText).toBe('fork 오류 자식 프로세스 waitpid')
  })

  it('course_qa is a reportable public target with hide_qa', () => {
    expect(ACTIONS_BY_TARGET.course_qa).toEqual(['none', 'hide_qa'])
    expect(reportTargetKey({ type: 'course_qa', courseQaId: 'q1' })).toBe('course_qa:q1')
  })

  it('analytics carry the target kind only', () => {
    expect(sanitizeAnalyticsProps('archive_transfer_requested', { target: 'course_qa' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('archive_transfer_completed', { target: 'stuck_log' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('archive_transfer_requested', { postId: 'x' }).ok).toBe(false)
    expect(sanitizeAnalyticsProps('course_qa_published', {}).ok).toBe(true)
    expect(sanitizeAnalyticsProps('course_qa_published', { courseId: 'x' }).ok).toBe(false)
    expect(Object.keys(ANALYTICS_PROP_SPECS.course_qa_published)).toEqual([])
  })
})
