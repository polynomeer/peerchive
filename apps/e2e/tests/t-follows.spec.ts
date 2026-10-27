/**
 * 시나리오 T·U. 비공개 계정과 팔로우, 차단(DELIVERY_PLAN §5.2, S-04, ADR 0033).
 * 학생 B가 설정 화면에서 비공개 계정으로 바꿉니다. 다른 학생 A가 B의 공개 프로필에서 팔로우 요청을 보내고, B가 설정 화면에서 승인하면 A가 B의
 * 팔로워 목록에 보입니다. 이어서 B가 A의 프로필 페이지에서 A를 차단하면 A에게 B의 프로필은 "찾을 수 없음"(관계 API 404)이고 팔로우가 끊깁니다.
 */
import type { MyFollowsDto, MyPersonasDto } from '../../web/shared/types/api'
import { expect, test } from '../support/fixtures'

test('T·U: 비공개 계정 팔로우 요청 → 승인, 차단하면 상대에게 404', async ({ newUser }) => {
  const owner = await newUser('bora')
  const fan = await newUser('ari')

  // B: 비공개 계정으로 바꾸기
  await owner.page.goto('/settings/follows')
  await owner.page.getByRole('radio', { name: /비공개 계정/ }).check()
  await owner.page.getByRole('button', { name: '설정 저장' }).click()
  await expect(owner.page.getByRole('status').filter({ hasText: '설정을 저장했습니다' })).toBeVisible()

  // A: B의 프로필에서 팔로우 요청
  await fan.page.goto(`/u/${owner.handle}`)
  await expect(fan.page.getByText('비공개 계정', { exact: true })).toBeVisible()
  await fan.page.getByRole('button', { name: '팔로우 요청' }).click()
  await expect(fan.page.getByRole('status').filter({ hasText: '팔로우를 요청했습니다' })).toBeVisible()
  await expect(fan.page.getByRole('button', { name: /요청 취소/ })).toBeVisible()

  // B: 받은 요청 승인
  await owner.page.goto('/settings/follows')
  await owner.page.getByRole('button', { name: `@${fan.handle} 요청 승인` }).click()
  await expect(owner.page.getByRole('status').filter({ hasText: '요청을 승인했습니다' })).toBeVisible()
  await expect(owner.page.getByRole('region', { name: /팔로워 1/ }).getByText(`@${fan.handle}`)).toBeVisible()
  const mine = await owner.api.get<MyPersonasDto>('/api/v1/me/personas')
  const realId = mine.personas.find((p) => p.kind === 'real')!.id
  expect((await owner.api.get<MyFollowsDto>(`/api/v1/personas/${realId}/follows`)).followers.map((f) => f.handle)).toEqual([fan.handle])

  // B: A의 프로필 페이지에서 차단 → A에게 B는 찾을 수 없음, 팔로우 삭제
  await owner.page.goto(`/u/${fan.handle}`)
  await owner.page.getByText('차단·뮤트').click()
  await owner.page.getByRole('button', { name: '차단', exact: true }).click()
  await expect(owner.page.getByRole('status').filter({ hasText: '차단했습니다' })).toBeVisible()

  expect((await fan.api.raw('GET', `/api/v1/profiles/${owner.handle}/social`)).status()).toBe(404)
  expect((await fan.api.raw('GET', `/api/v1/profiles/${owner.handle}/followers`)).status()).toBe(404)
  expect((await fan.api.raw('GET', `/api/v1/profiles/${owner.handle}`)).status()).toBe(404)
  expect((await fan.api.raw('POST', `/api/v1/profiles/${owner.handle}/follow`, { as: crypto.randomUUID() })).status()).toBe(404)
  await fan.page.goto(`/u/${owner.handle}`)
  await expect(fan.page.getByRole('heading', { level: 1, name: '프로필을 찾을 수 없습니다' })).toBeVisible()
  expect((await owner.api.get<MyFollowsDto>(`/api/v1/personas/${realId}/follows`)).followers).toEqual([])
  // 남의 관리 API는 404
  expect((await fan.api.raw('GET', `/api/v1/personas/${realId}/follows`)).status()).toBe(404)
})
