/**
 * A-03 멤버 명부 동의(DELIVERY_PLAN §4.3·§5.3 X, ADR 0040). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만 화면·API로 확인합니다:
 * 명부 API(쪽 보기·동의·철회)는 404, 방 화면에 명부 링크가 없고 명부 화면은 "찾을 수 없습니다", 내보내기처럼 보이는 경로도 404.
 * 켜진 상태의 규칙(동의 없는 행 0건·항목별 비우기·철회·나가기 즉시 삭제·멤버만·쪽 크기·rate limit·내보내기 경로 없음·경계)은
 * web 통합 테스트(member-directory·identity-boundary)가 덮습니다.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, test } from '../support/fixtures'

test('A-03: P2 alumni 플래그가 꺼져 있으면(기본) 멤버 명부 API는 404이고 화면 진입점이 없음', async ({ newUser }) => {
  const owner = await newUser('dirOff')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(owner.api, school.schoolId, domain, 'a')

  const created = await owner.api.raw('POST', '/api/v1/community/spaces', { name: `명부 방 ${rand(3)}`, nameMode: 'real' })
  expect(created.status()).toBe(201)
  const room = (await created.json()) as { slug: string }
  const base = `/api/v1/community/spaces/${room.slug}/directory`
  for (const [method, path, body] of [
    ['GET', base, undefined],
    ['GET', `${base}?page=1&pageSize=20`, undefined],
    ['PUT', `${base}/me`, { consent: true, currentWork: '개발' }],
    ['DELETE', `${base}/me`, undefined],
    ['GET', `${base}/export`, undefined],
    ['GET', `${base}.csv`, undefined],
  ] as const) {
    expect((await owner.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }

  const page = owner.page
  await page.goto(`/community/s/${room.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByTestId('directory-link')).toHaveCount(0)
  await page.goto(`/community/directory/${room.slug}`)
  await expect(page.getByRole('heading', { level: 1, name: '찾을 수 없습니다' })).toBeVisible()
})
