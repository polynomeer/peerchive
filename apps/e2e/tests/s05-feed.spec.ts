/**
 * S-05 프로필 글 → 팔로워 피드(DELIVERY_PLAN §4.2 S-05, ADR 0035).
 * 학생 A가 학생 B를 팔로우합니다(준비는 API). B가 자기 공개 프로필 `/u/<handle>`에서 짧은 글을 올리면 A의 `/feed`에 바로 보이고(같은 트랜잭션
 * 투영, worker를 기다리지 않음), B가 글을 지우면 A가 새로고침했을 때 사라집니다. 비로그인 방문자의 B 프로필에는 기본 공개 범위(로그인 사용자)라 글이 없습니다.
 */
import type { FeedDto } from '../../web/shared/types/api'
import { rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('S-05: 프로필 글을 올리면 팔로워의 피드에 보이고, 지우면 사라짐', async ({ newUser, anon }) => {
  const author = await newUser('bomi')
  const reader = await newUser('dain')
  const mine = await reader.api.get<{ personas: Array<{ id: string; kind: string }> }>('/api/v1/me/personas')
  await reader.api.post(`/api/v1/profiles/${author.handle}/follow`, { as: mine.personas.find((p) => p.kind === 'real')!.id })

  const text = `오늘 운영체제 과제 회고를 정리했어요 ${rand()}`
  await author.page.goto(`/u/${author.handle}`)
  await author.page.getByLabel('프로필에 짧은 글 쓰기').fill(text)
  await author.page.getByRole('button', { name: '올리기' }).click()
  await expect(author.page.getByRole('status').filter({ hasText: '글을 올렸습니다' })).toBeVisible()
  await expect(author.page.getByText(text)).toBeVisible()

  await reader.page.goto('/feed')
  await expect(reader.page.getByRole('heading', { level: 1, name: '피드' })).toBeVisible()
  const feed = reader.page.getByRole('region', { name: '팔로우 피드' })
  await expect(feed.getByText(text)).toBeVisible()
  await expect(feed.getByRole('link', { name: new RegExp(`@${author.handle}`) })).toBeVisible()

  // 비로그인 방문자: 공개 범위 기본값(로그인 사용자)이라 글이 없음.
  const visitor = await anon()
  await visitor.page.goto(`/u/${author.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 1 })).toContainText(`@${author.handle}`)
  await expect(visitor.page.getByText(text)).toHaveCount(0)

  // 지우면 다음 요청부터 피드에서 빠짐.
  author.page.once('dialog', (d) => void d.accept())
  await author.page.getByRole('button', { name: '지우기' }).click()
  await expect(author.page.getByRole('status').filter({ hasText: '글을 지웠습니다' })).toBeVisible()
  await reader.page.reload()
  await expect(reader.page.getByText(text)).toHaveCount(0)
  expect((await reader.api.get<FeedDto>('/api/v1/feed')).items).toEqual([])
  expect((await visitor.api.raw('GET', '/api/v1/feed')).status()).toBe(401)
})
