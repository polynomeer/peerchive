/**
 * I-02 기관 페이지·기수 방·기관 운영진(DELIVERY_PLAN §4.3 I-02·§5.3 Z, ADR 0044). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만
 * 화면·API로 확인합니다: 운영진·기수 방·집계·운영진 지정 API는 404, 화면 `/institutions/manage`는 "찾을 수 없습니다", 커뮤니티 첫 화면·운영자
 * 첫 화면에 진입점이 없고, DB에 준비한 기관 페이지는 그 기관 인증 계정에게도 404입니다.
 * 켜진 상태(권한 표·작성자 확인 403·기수 방 자격·집계 가림·라우트 검사·감사 id만)는 web 통합 테스트(institution-staff)가 덮습니다.
 */
import { rand } from '../support/api'
import { e2eSql, grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'

test('I-02: 플래그가 꺼져 있으면(기본) 기관 운영진·기수 방·집계 API와 화면 404, 진입점 없음, 기관 페이지도 404', async ({ newUser }) => {
  const operator = await newUser('instOp')
  grantOperator(operator.email)
  const staff = await newUser('instStaff')
  const [camp] = await e2eSql()<{ id: string }[]>`
    insert into schools (name, name_key, kind, created_by) values (${`캠프${rand(4)}`}, ${`camp${rand(6)}`}, 'bootcamp', ${operator.id}) returning id`
  await e2eSql()`insert into institution_staff (school_id, user_id, granted_by) values (${camp!.id}, ${staff.id}, ${operator.id})`
  const slug = rand(5)
  await e2eSql()`
    insert into community_spaces (kind, school_id, name, slug, current_name_mode, capacity, created_by)
    values ('official_school', ${camp!.id}, '캠프 기관 페이지', ${slug}, 'anonymous', 100000, ${operator.id})`

  for (const [method, path] of [
    ['GET', '/api/v1/me/institution-staff'],
    ['GET', `/api/v1/institutions/${camp!.id}/invite-codes`],
    ['POST', `/api/v1/institutions/${camp!.id}/invite-codes`],
    ['GET', `/api/v1/community/institutions/${camp!.id}`],
    ['GET', `/api/v1/community/institutions/${camp!.id}/stats`],
    ['POST', `/api/v1/community/institutions/${camp!.id}/cohort-rooms`],
    ['POST', `/api/v1/invite-codes/${crypto.randomUUID()}/revoke`],
  ] as const) {
    const res = method === 'GET' ? await staff.api.raw('GET', path) : await staff.api.raw('POST', path, { maxUses: 1, cohortLabel: '1기' })
    expect(res.status(), path).toBe(404)
  }
  for (const [method, path] of [
    ['GET', `/api/v1/operator/institutions/${camp!.id}/staff`],
    ['POST', `/api/v1/operator/institutions/${camp!.id}/staff`],
  ] as const) {
    const res = method === 'GET' ? await operator.api.raw('GET', path) : await operator.api.raw('POST', path, { userId: staff.id })
    expect(res.status(), path).toBe(404)
  }
  // 플래그가 꺼져 있으면 기관 페이지는 운영진·운영자에게도 없는 공간입니다.
  expect((await staff.api.raw('GET', `/api/v1/community/spaces/${slug}`)).status()).toBe(404)
  expect((await operator.api.raw('GET', `/api/v1/community/spaces/${slug}`)).status()).toBe(404)

  await staff.page.goto('/institutions/manage')
  await expect(staff.page.getByRole('heading', { name: '페이지를 찾을 수 없습니다' })).toBeVisible()
  await staff.page.goto('/community')
  await expect(staff.page.getByRole('heading', { name: '커뮤니티', level: 1 })).toBeVisible()
  await expect(staff.page.getByTestId('institution-manage-link')).toHaveCount(0)
  await operator.page.goto('/operator')
  await expect(operator.page.getByRole('link', { name: '기관 운영진' })).toHaveCount(0)
})
