/**
 * C-08 스터디 기록(DELIVERY_PLAN §4.1 C-08·§5.1 N, PROOFU_EVOLUTION_PLAN §8.9.5·§8.9.8, ADR 0026). 빌드한 실제 서버로:
 * - 표시명 스터디 방: 스터디 모집(C-07) → 선정 → 마감 → 초대 수락으로 만든 방에서 방장이 화면으로 "스터디 기록 켜기" → 멤버가 기록 탭에서 로그 작성 →
 *   공개 후보(방 멤버 모두 당사자) → 멤버가 동의 화면에서 동의 → 게시 → /p 와 과목 허브에 "스터디 기록"·"스터디" 배지.
 * - 익명 스터디 방: 기록 안 다른 멤버 이름이 "스터디 멤버 N", 공개 뒤 케이스 스터디 422 anonymous_study, 포트폴리오 출처 목록에 없음.
 * desktop·360px에서 가로 스크롤 없음. 모집·후보 준비는 API로 합니다.
 */
import type { LogDto, ProjectDetailDto, RecruitmentDetailDto, StudyRecordStateDto } from '../../web/shared/types/api'
import { type Api, createCandidate, consent, pastTerm, progressLog, publish, rand, setCourseTerm } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

/** 스터디 모집(과목) → 지원 → 선정 → 마감 → 선정된 사람이 초대를 받아 수락. 방 slug를 돌려줍니다. */
async function studyRoomViaRecruitment(recruiter: Api, member: Api, courseId: string, title: string, roomNameMode: 'display' | 'anonymous'): Promise<string> {
  const rec = await recruiter.post<RecruitmentDetailDto>('/api/v1/community/recruitments', { kind: 'study', courseId, title, capacity: 2, roomNameMode })
  const app = await member.post<{ id: string }>(`/api/v1/community/recruitments/${rec.id}/applications`, { message: '함께해요' })
  await recruiter.post(`/api/v1/community/recruitments/${rec.id}/applications/${app.id}/accept`)
  const closed = await recruiter.post<RecruitmentDetailDto>(`/api/v1/community/recruitments/${rec.id}/close`)
  const slug = closed.recruiter!.result.spaceSlug!
  const { inviteUrl } = await member.post<{ inviteUrl: string }>(`/api/v1/community/recruitments/${rec.id}/invitation`)
  await member.post('/api/v1/community/invitations/accept', { token: new URL(inviteUrl).pathname.split('/').pop() })
  return slug
}

test('C-08: 스터디 방에서 기록 켜기 → 기록 탭에서 로그 → 멤버 동의 → 게시 → 공개 사례·과목 허브에 스터디 표시', async ({ newUser, anon }) => {
  test.setTimeout(180_000)
  const owner = await newUser('studyown')
  const member = await newUser('studymem')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  for (const [u, prefix] of [[owner, 'o'], [member, 'm']] as const) await verifyByApi(u.api, school.schoolId, domain, prefix)
  const roomTitle = `E2E 자료구조 스터디 ${rand(3)}`
  const slug = await studyRoomViaRecruitment(owner.api, member.api, school.courseId, roomTitle, 'display')

  // 방장: 기록 탭 → 과목 학기를 고르지 않고 "스터디 기록 켜기"(화면)
  const page = owner.page
  await page.goto(`/community/s/${slug}`)
  await page.getByRole('tab', { name: '기록' }).click()
  const record = page.getByTestId('study-record')
  await expect(record.getByRole('heading', { name: '스터디 기록' })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await record.getByRole('button', { name: '스터디 기록 켜기' }).click()
  await expect(record.getByText('스터디 기록', { exact: true }).first()).toBeVisible()
  await expect(record.getByTestId('study-publish-link')).toBeVisible()
  const state = await owner.api.get<StudyRecordStateDto>(`/api/v1/community/spaces/${slug}/study-record`)
  const projectId = state.projectId!
  expect(state.enabled).toBe(true)
  // 과목 학기 연결(과제 화면에서도 바꾸는 값, 준비는 API) → 게시 때 과목 허브에 걸림
  await setCourseTerm(owner.api, projectId, school.termId)

  // 멤버: 기록 탭에서 로그 쓰기(과제 화면과 같은 컴포넌트). 기록 제목에 방 이름이 들어가지 않음.
  const line = `1주차: 스택·큐 정리 ${rand()}`
  await member.page.goto(`/community/s/${slug}#record`)
  const composer = member.page.getByRole('form', { name: '빌드 로그 쓰기' })
  await composer.getByLabel('내용 (필수)').fill(line)
  await composer.getByRole('button', { name: '기록하기' }).click()
  await expect(composer.getByRole('status')).toHaveText('저장됨')
  await expect(member.page.getByRole('list', { name: '로그 목록 (최신순)' }).getByText(line)).toBeVisible()
  await expectNoHorizontalScroll(member.page)
  const project = await member.api.get<ProjectDetailDto>(`/api/v1/projects/${projectId}`)
  expect(project).toMatchObject({ kind: 'study', myRole: 'editor' })
  expect(project.title).not.toContain(roomTitle)
  // 과제 쪽에서 멤버를 관리할 수 없음(방이 원천)
  expect((await owner.api.raw('POST', `/api/v1/projects/${projectId}/invitations`, { role: 'editor' })).status()).toBe(409)
  // 방 밖 사람은 기록을 못 봄
  const outsider = await newUser('studyout')
  expect((await outsider.api.raw('GET', `/api/v1/projects/${projectId}`)).status()).toBe(404)

  // 공개 후보(준비는 API, 멤버 이름 노출) → 멤버는 동의 화면에서 동의
  const logs = await owner.api.get<{ items: LogDto[] }>(`/api/v1/projects/${projectId}/logs`)
  const publicTitle = `스터디 회고 ${rand()}`
  const publicSlug = `e2e-study-${rand(4)}`
  const candidate = await createCandidate(owner.api, projectId, {
    level: 'summary',
    title: publicTitle,
    slug: publicSlug,
    logIds: logs.items.map((l) => l.id),
    exposure: { [member.id]: 'name' },
  })
  expect(candidate.subjects.map((s) => s.userId).sort()).toEqual([owner.id, member.id].sort())
  expect((await owner.api.raw('POST', `/api/v1/candidates/${candidate.id}/publish`, { manifestHash: candidate.manifestHash })).status()).toBe(409)
  await member.page.goto('/consents')
  await member.page.getByRole('listitem').filter({ hasText: publicTitle }).getByRole('link', { name: '미리보기·결정' }).click()
  const decision = member.page.getByRole('region', { name: '내 결정' })
  await decision.getByRole('button', { name: '이 내용 공개에 동의' }).click()
  await expect(decision).toContainText('내 동의: 동의함')
  await publish(owner.api, candidate)

  // 공개 사례와 과목 허브: "스터디 기록"·"스터디" 배지
  const visitor = await anon()
  await visitor.page.goto(`/p/${publicSlug}`)
  await expect(visitor.page.getByRole('heading', { name: publicTitle })).toBeVisible()
  await expect(visitor.page.getByTestId('study-badge')).toHaveText('스터디 기록')
  await expect(visitor.page.getByText(line, { exact: true })).toBeVisible()
  await expect(visitor.page.getByText(roomTitle)).toHaveCount(0)
  await expectNoHorizontalScroll(visitor.page)
  await visitor.page.goto(`/c/${school.courseId}`)
  const card = visitor.page.getByRole('listitem').filter({ hasText: publicTitle }).last()
  await expect(card.getByTestId('hub-study-badge')).toHaveText('스터디')
  await expectNoHorizontalScroll(visitor.page)
})

test('C-08: 익명 스터디 방의 기록은 이름을 가리고 포트폴리오에 연결할 수 없다', async ({ newUser }) => {
  test.setTimeout(150_000)
  const owner = await newUser('anonown')
  const member = await newUser('anonmem')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  for (const [u, prefix] of [[owner, 'o'], [member, 'm']] as const) await verifyByApi(u.api, school.schoolId, domain, prefix)
  const slug = await studyRoomViaRecruitment(owner.api, member.api, school.courseId, `E2E 익명 스터디 ${rand(3)}`, 'anonymous')
  const state = await owner.api.post<StudyRecordStateDto>(`/api/v1/community/spaces/${slug}/study-record`, {})
  expect(state).toMatchObject({ nameMode: 'anonymous', portfolioLinkable: false })
  const projectId = state.projectId!
  const line = `익명 기록 ${rand()}`
  await progressLog(member.api, projectId, line)

  // 방장 화면: 멤버의 로그 작성자는 "스터디 멤버 N", 익명 안내
  await owner.page.goto(`/community/s/${slug}#record`)
  const record = owner.page.getByTestId('study-record')
  await expect(record.getByText(/포트폴리오·공개 프로필에 연결되지 않습니다/)).toBeVisible()
  const item = owner.page.getByRole('list', { name: '로그 목록 (최신순)' }).getByRole('listitem').filter({ hasText: line }).first()
  await expect(item).toContainText(/스터디 멤버 \d/)
  await expect(item).not.toContainText(member.displayName)
  await expectNoHorizontalScroll(owner.page)

  // 이름 노출 후보는 422, 모두 익명으로 공개
  expect((await owner.api.raw('POST', `/api/v1/projects/${projectId}/publication-candidates`, {
    level: 'summary', title: '익명 스터디', summary: '요약', slug: `e2e-anon-${rand(4)}`, logIds: [], exposure: { [member.id]: 'name' },
  })).status()).toBe(422)
  const logs = await owner.api.get<{ items: LogDto[] }>(`/api/v1/projects/${projectId}/logs`)
  const publicSlug = `e2e-anon-${rand(4)}`
  const candidate = await createCandidate(owner.api, projectId, { level: 'summary', title: `익명 스터디 ${rand()}`, slug: publicSlug, logIds: logs.items.map((l) => l.id) })
  await consent(member.api, candidate)
  await publish(owner.api, candidate)

  // 케이스 스터디(포트폴리오) 422 anonymous_study, 출처 목록에도 없음
  const res = await member.api.raw('POST', '/api/v1/case-studies', { releaseSlug: publicSlug, jobTarget: 'backend', revealSelf: true })
  expect(res.status()).toBe(422)
  expect(JSON.stringify(await res.json())).toContain('anonymous_study')
  await member.page.goto('/portfolio')
  await expect(member.page.getByRole('heading', { level: 1, name: '포트폴리오' })).toBeVisible()
  await expect(member.page.getByText(publicSlug)).toHaveCount(0)
  const sources = await member.api.get<Array<{ slug: string }>>('/api/v1/me/case-study-sources')
  expect(sources.map((s) => s.slug)).not.toContain(publicSlug)
})
