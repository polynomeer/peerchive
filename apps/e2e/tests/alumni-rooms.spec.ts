/**
 * A-01 동문회·OB 방(DELIVERY_PLAN §4.3, ADR 0038). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만 화면·API로 확인합니다:
 * 방 만들기에 방 종류(동문회·OB) 선택이 없고, alumni 템플릿 요청과 방별 프로필 API는 404, 일반 방은 그대로 만들어짐(template general).
 * 켜진 상태의 규칙(멤버만·실명 고정·기수 이력·글의 배지·나가기 삭제·경계)은 web 통합 테스트(room-profiles·identity-boundary)가 덮습니다.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, test } from '../support/fixtures'

test('A-01: P2 alumni 플래그가 꺼져 있으면(기본) 동문회·OB 방 종류가 없고 방별 프로필 API는 404, 일반 방은 그대로', async ({ newUser }) => {
  const owner = await newUser('alumnioff')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(owner.api, school.schoolId, domain, 'a')

  const page = owner.page
  await page.goto('/community')
  await expect(page.getByRole('heading', { level: 2, name: '방 만들기' })).toBeVisible()
  await expect(page.getByTestId('room-template')).toHaveCount(0)
  await expect(page.getByText('동문회·OB')).toHaveCount(0)

  const refused = await owner.api.raw('POST', '/api/v1/community/spaces', { name: `동문 방 ${rand(3)}`, nameMode: 'display', template: 'alumni' })
  expect(refused.status()).toBe(404)
  const created = await owner.api.raw('POST', '/api/v1/community/spaces', { name: `일반 방 ${rand(3)}`, nameMode: 'display' })
  expect(created.status()).toBe(201)
  const room = (await created.json()) as { slug: string; template: string }
  expect(room.template).toBe('general')
  for (const [method, path, body] of [
    ['GET', `/api/v1/community/spaces/${room.slug}/room-profiles`, undefined],
    ['PUT', `/api/v1/community/spaces/${room.slug}/room-profile`, { displayName: '12기' }],
    ['DELETE', `/api/v1/community/spaces/${room.slug}/room-profile`, undefined],
    ['PUT', `/api/v1/community/spaces/${room.slug}/room-profiles/${crypto.randomUUID()}/cohort`, { cohortLabel: '1기' }],
    ['GET', `/api/v1/community/spaces/${room.slug}/room-profiles/${crypto.randomUUID()}/cohort-history`, undefined],
  ] as const) {
    expect((await owner.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }
  await page.goto(`/community/s/${room.slug}`)
  await expect(page.getByTestId('room-profiles-link')).toHaveCount(0)
  await page.goto(`/community/room-profiles/${room.slug}`)
  await expect(page.getByRole('heading', { level: 1, name: '찾을 수 없습니다' })).toBeVisible()
})
