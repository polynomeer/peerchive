/**
 * C-07 모집·지원·마감(DELIVERY_PLAN §4.1 C-07·§5.1 N, PROOFU_EVOLUTION_PLAN §8.8·§8.9.5, ADR 0024). 빌드한 실제 서버로, 화면에서:
 * - 스터디: 과목 화면의 "이 과목 팀원 찾기"(같은 학교 인증 사용자에게만) → 스터디 모집 올리기 → 둘이 지원 → 모집자가 지원 순서대로 보고 한 명 선정 →
 *   마감(스터디 방 생성) → 선정된 사람이 초대 받기 → 초대 수락 → 스터디 방 멤버. 선정되지 않은 사람은 "모집이 마감되었거나 선정되지 않았습니다"만 봄.
 * - 팀원 찾기: 학기를 고른 팀원 모집 → 지원 → 선정 → 마감(비공개 과제 공간) → 선정된 사람은 초대를 수락하기 전에는 과제 공간을 못 보고, 수락하면 들어감.
 * - 지원자 목록은 모집자만(다른 지원자는 403), desktop·360px에서 가로 스크롤 없음.
 * 준비(학교 인증·과목)는 API로 합니다.
 */
import type { RecruitmentDetailDto } from '../../web/shared/types/api'
import { futureTerm, pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

test('C-07: 스터디 모집 → 둘 지원 → 한 명 선정 → 마감 → 스터디 방 → 초대 수락', async ({ newUser, anon }) => {
  test.setTimeout(180_000)
  const recruiter = await newUser('studyrec')
  const first = await newUser('studya')
  const second = await newUser('studyb')
  const school = await pastTerm(recruiter.api)
  const { domain } = schoolMailbox(school.schoolId)
  for (const [u, prefix] of [[recruiter, 'r'], [first, 'a'], [second, 'b']] as const) await verifyByApi(u.api, school.schoolId, domain, prefix)
  const title = `E2E 운영체제 스터디 ${rand(3)}`

  // 과목 허브: 같은 학교 인증 사용자에게만 "이 과목 팀원 찾기"(비로그인은 없음)
  const page = recruiter.page
  await page.goto(`/c/${school.courseId}`)
  await page.getByRole('link', { name: '이 과목 팀원 찾기·스터디 모집' }).click()
  await page.waitForURL(new RegExp(`/community/recruitments\\?course=${school.courseId}$`))
  const visitor = await anon()
  await visitor.page.goto(`/c/${school.courseId}`)
  await expect(visitor.page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(visitor.page.getByTestId('course-team-finding')).toHaveCount(0)

  // 모집 올리기(화면)
  await expect(page.getByRole('heading', { level: 1, name: '모집' })).toBeVisible()
  await page.getByLabel('스터디 모집(스터디 방과 초대로 이어짐)').check()
  await page.getByLabel('제목').fill(title)
  await page.getByLabel(/^소개/).fill('매주 수요일 저녁 온라인')
  await page.getByLabel(/^모집 인원/).fill('2')
  await expect(page.getByLabel('표시명(기본)')).toBeChecked()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: '모집 올리기' }).click()
  await page.waitForURL(/\/community\/recruitments\/[0-9a-f-]{36}$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByTestId('recruitment-kind')).toHaveText('스터디')

  // 두 사람이 지원(화면). 먼저 지원한 사람이 먼저 보임.
  for (const [u, msg] of [[first, '첫 번째 지원'], [second, '두 번째 지원']] as const) {
    await u.page.goto(`/community/recruitments?course=${school.courseId}`)
    await u.page.getByRole('link', { name: title }).click()
    await u.page.getByLabel('하고 싶은 말(선택)').fill(msg)
    await u.page.getByRole('button', { name: '지원하기' }).click()
    await expect(u.page.getByTestId('my-application-status')).toHaveText('검토 중')
    await expectNoHorizontalScroll(u.page)
  }
  // 다른 지원자는 지원자 목록을 볼 수 없음
  expect((await second.api.raw('GET', `/api/v1/community/recruitments/${id}/applications`)).status()).toBe(403)
  expect(await second.page.getByTestId('recruiter-dashboard').count()).toBe(0)

  // 모집자: 지원 순서대로, 첫 번째 선정 → 마감
  await page.reload()
  const items = page.getByTestId('application-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText(first.displayName)
  await expect(items.nth(1)).toContainText(second.displayName)
  await expect(page.getByTestId('recruiter-dashboard')).not.toContainText(/포크|확인 수|점수|활동량 [0-9]/)
  await items.nth(0).getByRole('button', { name: '선정', exact: true }).click()
  await expect(items.nth(0).getByTestId('application-item-status')).toHaveText('선정')
  await page.getByRole('button', { name: '마감하고 스터디 방 만들기' }).click()
  await expect(page.getByTestId('recruitment-status')).toHaveText('마감')
  await expect(page.getByTestId('result-link')).toHaveText('만들어진 스터디 방 열기')
  await expectNoHorizontalScroll(page)
  const detail = await recruiter.api.get<RecruitmentDetailDto>(`/api/v1/community/recruitments/${id}`)
  const slug = detail.recruiter!.result.spaceSlug!

  // 선정되지 않은 사람: 사유 없는 같은 문장, 방은 못 봄
  await second.page.reload()
  await expect(second.page.getByTestId('my-application-status')).toHaveText('모집이 마감되었거나 선정되지 않았습니다.')
  expect((await second.api.raw('GET', `/api/v1/community/spaces/${slug}`)).status()).toBe(404)

  // 선정된 사람: 알림 → 초대 받기 → 초대 수락 → 멤버(수락 전에는 멤버가 아님)
  await first.page.goto('/community/notices')
  await expect(first.page.getByRole('link', { name: /선정되었습니다/ })).toBeVisible()
  expect((await first.api.raw('GET', `/api/v1/community/spaces/${slug}`)).status()).toBe(404)
  await first.page.getByRole('link', { name: /선정되었습니다/ }).click()
  await first.page.waitForURL(new RegExp(`/community/recruitments/${id}$`))
  await expect(first.page.getByTestId('my-application-status')).toHaveText('선정됨')
  await first.page.getByRole('button', { name: '스터디 방 초대 받기' }).click()
  await first.page.getByTestId('invite-link').click()
  await first.page.waitForURL(/\/community\/invite\//)
  await expect(first.page.getByRole('heading', { level: 2, name: title })).toBeVisible()
  await first.page.getByRole('button', { name: '초대 수락' }).click()
  await first.page.waitForURL(new RegExp(`/community/s/${slug}$`))
  await expect(first.page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expectNoHorizontalScroll(first.page)

  // 커뮤니티 경계: noindex, 비로그인 401, 공개 검색에 제목 없음
  const api = await first.api.raw('GET', `/api/v1/community/recruitments/${id}`)
  expect(api.headers()['x-robots-tag']).toBe('noindex, nofollow, noarchive')
  expect((await visitor.api.raw('GET', `/api/v1/community/recruitments/${id}`)).status()).toBe(401)
  const search = await visitor.api.raw('GET', `/api/v1/public/search?q=${encodeURIComponent(title)}`)
  expect(((await search.json()) as { results: unknown[] }).results).toEqual([])
})

test('C-07: 팀원 찾기 → 지원 → 선정 → 마감 → 비공개 과제 공간 초대 수락', async ({ newUser }) => {
  test.setTimeout(150_000)
  const recruiter = await newUser('teamrec')
  const mate = await newUser('teammate')
  const school = await futureTerm(recruiter.api)
  const { domain } = schoolMailbox(school.schoolId)
  for (const [u, prefix] of [[recruiter, 'r'], [mate, 'm']] as const) await verifyByApi(u.api, school.schoolId, domain, prefix)
  const title = `E2E 팀원 구해요 ${rand(3)}`

  const page = recruiter.page
  await page.goto(`/community/recruitments?course=${school.courseId}`)
  await page.getByLabel('팀원 찾기(과제 공간과 초대로 이어짐)').check()
  await page.getByLabel('제목').fill(title)
  await page.getByLabel(/^모집 인원/).fill('2')
  await page.getByLabel('학기(선택)').selectOption(school.termId)
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: '모집 올리기' }).click()
  await page.waitForURL(/\/community\/recruitments\/[0-9a-f-]{36}$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByTestId('recruitment-kind')).toHaveText('팀원')

  await mate.page.goto(`/community/recruitments/${id}`)
  await mate.page.getByRole('button', { name: '지원하기' }).click()
  await expect(mate.page.getByTestId('my-application-status')).toHaveText('검토 중')

  await page.reload()
  await page.getByTestId('application-item').first().getByRole('button', { name: '선정', exact: true }).click()
  await expect(page.getByTestId('application-item').first().getByTestId('application-item-status')).toHaveText('선정')
  await page.getByRole('button', { name: '마감하고 과제 공간 만들기' }).click()
  await expect(page.getByTestId('result-link')).toHaveText('만들어진 팀 과제 공간(비공개) 열기')
  const detail = await recruiter.api.get<RecruitmentDetailDto>(`/api/v1/community/recruitments/${id}`)
  const projectId = detail.recruiter!.result.projectId!
  // 모집자 화면에서 과제 공간으로
  await page.getByTestId('result-link').click()
  await page.waitForURL(new RegExp(`/projects/${projectId}`))
  await expectNoHorizontalScroll(page)

  // 선정된 사람: 수락 전에는 과제 공간 404 → 초대 받기 → 수락 → 들어감
  expect((await mate.api.raw('GET', `/api/v1/projects/${projectId}`)).status()).toBe(404)
  await mate.page.reload()
  await expect(mate.page.getByTestId('my-application-status')).toHaveText('선정됨')
  await mate.page.getByRole('button', { name: '팀 과제 공간 초대 받기' }).click()
  await mate.page.getByTestId('invite-link').click()
  await mate.page.waitForURL(/\/invite\//)
  await mate.page.getByRole('button', { name: '초대 수락' }).click()
  await mate.page.waitForURL(new RegExp(`/projects/${projectId}`))
  expect((await mate.api.raw('GET', `/api/v1/projects/${projectId}`)).status()).toBe(200)
  await expectNoHorizontalScroll(mate.page)
})
