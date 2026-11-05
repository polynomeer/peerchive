/**
 * E-03 학생 큐레이터(DELIVERY_PLAN §4.4 E-03, ADR 0048).
 * 운영자가 과목을 마친(끝난 학기 과제 공간) + 그 학교 인증(준비: DB) 학생을 큐레이터로 지정하면, 학생은 홈 "큐레이터 과목"에서 큐레이터 화면으로 가
 * 과제 유형 요약을 쓰고, 과목 허브에 작성자 없이 공개됩니다. 공개 프로필 "후배 기여"의 큐레이터 과목은 본인이 켰을 때만 보입니다.
 * 운영자가 해제하면 큐레이터 화면은 바로 "찾을 수 없습니다"입니다. 권한 표·신고 의견·병합 제안 승인은 web 통합 테스트(curators)가 덮습니다.
 */
import type { OperatorCourseCuratorDto } from '../../web/shared/types/api'
import { createProject, pastTerm } from '../support/api'
import { e2eSql, grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'

test('E-03: 운영자 지정 → 큐레이터가 과제 유형 요약 작성(허브 공개) → 포트폴리오 표시는 본인 선택 → 해제하면 바로 권한 없음', async ({ newUser }) => {
  const operator = await newUser('curOp')
  grantOperator(operator.email)
  const curator = await newUser('curator')
  const { page, api } = curator
  const course = await pastTerm(api)
  await createProject(api, { title: '지난 학기 과제', courseTermId: course.termId })
  await e2eSql()`
    insert into institution_affiliations (user_id, school_id, email_hash, email_domain, standing, status, verified_at)
    values (${curator.id}, ${course.schoolId}, ${crypto.randomUUID().replace(/-/g, '').repeat(2)}, 'fixture.ac.kr', 'alumni', 'active', now())`

  // 운영자만 지정합니다(학생 403).
  expect((await api.raw('POST', `/api/v1/operator/courses/${course.courseId}/curators`, { userId: curator.id })).status()).toBe(403)
  expect((await api.raw('GET', `/api/v1/curator/courses/${course.courseId}`)).status()).toBe(403)
  const assigned = await operator.api.post<OperatorCourseCuratorDto[]>(`/api/v1/operator/courses/${course.courseId}/curators`, { userId: curator.id })
  expect(assigned.map((c) => c.userId)).toEqual([curator.id])
  expect(assigned[0]!.status).toBe('pending')

  // 지정은 제안입니다. 수락 전에는 권한이 없고, 홈에서 수락합니다(ADR 0060 D-08).
  expect((await api.raw('GET', `/api/v1/curator/courses/${course.courseId}`)).status()).toBe(403)
  await page.goto('/')
  const card = page.getByRole('region', { name: '큐레이터 과목' })
  await expect(card.getByTestId('curator-proposals')).toContainText(course.courseTitle)
  await card.getByRole('button', { name: '수락' }).click()
  await expect(card.getByTestId('curator-proposals')).toHaveCount(0)
  await card.getByRole('link', { name: new RegExp(course.courseTitle) }).click()
  await expect(page.getByRole('heading', { level: 1, name: course.courseTitle })).toBeVisible()
  await page.getByTestId('curator-summary-body').fill('개인 구현 과제 4개와 팀 프로젝트 1개. 주차마다 짧은 보고서.')
  await page.getByRole('button', { name: '저장' }).click()
  await expect(page.getByRole('status').filter({ hasText: '과제 유형 요약을 저장했습니다' })).toBeVisible()
  await expect(page.getByTestId('curator-reports')).toContainText('검토할 신고가 없습니다')

  await page.goto(`/c/${course.courseId}`)
  const summary = page.getByTestId('hub-assignment-types')
  await expect(summary).toContainText('개인 구현 과제 4개와 팀 프로젝트 1개')
  await expect(summary).not.toContainText(curator.displayName)

  // 포트폴리오 표시: 기본 꺼짐 → 켜면 공개 프로필 "후배 기여"에 과목 이름.
  await page.goto(`/u/${curator.handle}`)
  await expect(page.getByRole('heading', { name: '후배 기여' })).toBeVisible()
  await expect(page.getByTestId('curated-courses')).toHaveCount(0)
  await page.goto('/')
  // 체크 표시는 저장보다 먼저 바뀌므로 응답을 기다립니다. 바로 페이지를 옮기면 저장 요청이 취소될 수 있습니다.
  const saved = page.waitForResponse((r) => r.url().includes('/api/v1/me/curated-courses/') && r.request().method() === 'PATCH' && r.ok())
  await page.getByRole('region', { name: '큐레이터 과목' }).getByRole('checkbox').check()
  await saved
  await page.goto(`/u/${curator.handle}`)
  await expect(page.getByTestId('curated-courses')).toContainText(course.courseTitle)

  // 해제하면 다음 요청부터 권한 없음, 포트폴리오 표시도 사라짐.
  expect((await operator.api.raw('DELETE', `/api/v1/operator/courses/${course.courseId}/curators/${curator.id}`)).status()).toBe(200)
  await page.goto(`/curator/${course.courseId}`)
  await expect(page.getByRole('heading', { name: '페이지를 찾을 수 없습니다' })).toBeVisible()
  await page.goto(`/u/${curator.handle}`)
  await expect(page.getByTestId('curated-courses')).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByTestId('home-curator-courses')).toHaveCount(0)
})
