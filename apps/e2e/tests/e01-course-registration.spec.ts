/**
 * E-01 이번 학기 과목 등록(DELIVERY_PLAN §4.4 E-01, ADR 0046).
 * 카탈로그에 과목을 준비(API)한 뒤 학생이 `/me/courses`에서 학교·과목을 검색해 지금 학기로 등록하면, 홈에 그 과목의 과목 허브·선배 노트·플랜 포크·
 * 과제 공간 만들기 진입점이 보이고, 과제 공간 만들기는 과목·학기를 채운 채 열립니다. 다른 사용자의 홈에는 나오지 않습니다.
 */
import type { MyCourseRegistrationsDto } from '../../web/shared/types/api'
import { rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('E-01: 과목 등록 → 홈에 과목별 진입점, 등록 과목에서 과제 공간 만들기', async ({ newUser }) => {
  const student = await newUser('sena')
  const { page, api } = student
  const school = await api.post<{ id: string; name: string }>('/api/v1/schools', { name: `등록대학교 ${rand()}`, confirmNew: true })
  const courseTitle = `운영체제 ${rand()}`
  const course = await api.post<{ id: string }>(`/api/v1/schools/${school.id}/courses`, { title: courseTitle, confirmNew: true })

  await page.goto('/me/courses')
  await expect(page.getByRole('heading', { level: 1, name: '내 과목' })).toBeVisible()
  await page.getByLabel('학교 검색').fill(school.name)
  await page.getByRole('button', { name: school.name }).click()
  await page.getByRole('button', { name: courseTitle }).click()
  await expect(page.getByLabel('학기')).toBeVisible()
  await page.getByRole('button', { name: '등록하기' }).click()
  await expect(page.getByRole('status').filter({ hasText: '등록했습니다' })).toBeVisible()
  await expect(page.getByRole('list', { name: '등록한 과목 목록' }).getByRole('link', { name: courseTitle })).toBeVisible()

  await page.goto('/')
  const section = page.getByRole('region', { name: '이번 학기 과목' })
  await expect(section.getByText(courseTitle)).toBeVisible()
  await expect(section.getByRole('link', { name: '과목 허브' })).toHaveAttribute('href', `/c/${course.id}`)
  await expect(section.getByRole('link', { name: '선배 노트' })).toHaveAttribute('href', `/c/${course.id}#hub-notes`)
  await expect(section.getByRole('link', { name: '플랜 포크' })).toHaveAttribute('href', `/c/${course.id}#hub-cases`)

  await section.getByRole('link', { name: '이 과목으로 과제 공간 만들기' }).click()
  await expect(page.getByTestId('registration-prefill')).toContainText(courseTitle)
  await expect(page.getByLabel('과제 이름')).toHaveValue(`${courseTitle} 과제`)
  await page.getByRole('button', { name: '만들기' }).click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/)
  await expect(page.getByText(courseTitle).first()).toBeVisible()

  // 다른 사용자에게는 등록이 없습니다.
  const other = await newUser('yuna')
  expect((await other.api.get<MyCourseRegistrationsDto>('/api/v1/me/course-registrations')).items).toEqual([])
})
