/**
 * E-02 과목 허브 단계적 개방(DELIVERY_PLAN §4.4 E-02, ADR 0047). E2E 서버는 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만 화면·API로 확인합니다:
 * 공개 사례·선배 노트가 하나도 없는 과목도 허브가 지금처럼 열려 있고("준비 중" 없음), 기능 플래그는 꺼짐, 본인 화면 API는 404.
 * 켜진 상태의 규칙(기준 미만 "준비 중"·기준 도달 시 열림·병합 합산·알림 신청·선배 노트 요청·운영자 진행)은 web 통합 테스트
 * (course-hub-opening)가 덮습니다.
 */
import type { FeatureFlagsDto } from '../../web/shared/types/api'
import { rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('E-02: 단계적 개방 플래그가 꺼져 있으면(기본) 빈 과목도 허브가 열려 있고 본인 화면 API는 404', async ({ newUser }) => {
  const student = await newUser('hubopen')
  const { page, api } = student
  const school = await api.post<{ id: string; name: string }>('/api/v1/schools', { name: `개방대학교 ${rand()}`, confirmNew: true })
  const courseTitle = `자료구조 ${rand()}`
  const course = await api.post<{ id: string }>(`/api/v1/schools/${school.id}/courses`, { title: courseTitle, confirmNew: true })

  expect((await api.get<FeatureFlagsDto>('/api/v1/features')).hubStagedOpening).toBe(false)

  await page.goto(`/c/${course.id}`)
  await expect(page.getByRole('heading', { level: 1, name: courseTitle })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: '공개 사례' })).toBeVisible()
  await expect(page.getByTestId('hub-preparing')).toHaveCount(0)

  for (const [method, path] of [
    ['GET', `/api/v1/me/course-hubs/${course.id}/opening`],
    ['POST', `/api/v1/me/course-hubs/${course.id}/notify`],
    ['GET', '/api/v1/me/course-hub-notices'],
  ] as const) {
    expect((await api.raw(method, path)).status(), `${method} ${path}`).toBe(404)
  }

  await page.goto('/')
  await expect(page.getByTestId('home-hub-notices')).toHaveCount(0)
})
