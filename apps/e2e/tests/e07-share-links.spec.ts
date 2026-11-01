/**
 * E-07 제한 공유 링크(DELIVERY_PLAN §4.4 E-07, ADR 0051). 학생이 포트폴리오 화면에서 지금 판의 공유 링크를 만들면, 로그인하지 않은 사람이
 * `/s/<token>`에서 그 판의 대표 케이스를 봅니다(늘 noindex·no-referrer). 학생이 철회하면 다음 요청부터 페이지와 API 모두 404입니다.
 * 해시 저장·만료·지난 판·공개 범위·S-01 규칙·열람 한도·탈퇴 정리는 web/worker 통합 테스트가 덮습니다.
 */
import type { ShareLinkDto } from '../../web/shared/types/api'
import { featureCaseStudy } from '../support/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('E-07: 공유 링크를 만들어 익명으로 열고, 철회하면 404가 된다', async ({ newUser, anon }) => {
  const student = await newUser('share')
  const pub = await publishCase(student)
  const { caseStudy } = await featureCaseStudy(student.api, pub.slug)

  const { page } = student
  await page.goto('/portfolio')
  const section = page.getByTestId('share-links')
  await section.getByLabel('이름(선택, 나만 봄)').fill('채용 담당자')
  await section.getByRole('button', { name: /공유 링크 만들기/ }).click()
  await expect(section.getByRole('status')).toContainText('공유 링크를 만들었습니다')
  const url = await section.getByLabel('새 공유 링크 주소').inputValue()
  const path = new URL(url).pathname
  expect(path).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/)

  const visitor = await anon()
  const opened = await visitor.page.goto(path)
  expect(opened!.status()).toBe(200)
  const headers = opened!.headers()
  expect(headers['x-robots-tag']).toContain('noindex')
  expect(headers['referrer-policy']).toBe('no-referrer')
  const shared = visitor.page.getByTestId('shared-portfolio')
  await expect(shared.getByRole('heading', { level: 1 })).toContainText(student.displayName)
  await expect(shared.getByRole('heading', { level: 3, name: caseStudy.title })).toBeVisible()
  await expect(visitor.page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)

  // 열람 횟수만 셉니다.
  const [link] = (await student.api.get<ShareLinkDto[]>('/api/v1/me/share-links')).filter((l) => l.label === '채용 담당자')
  expect(link!.viewCount).toBeGreaterThanOrEqual(1)
  await page.reload()
  await expect(section.locator(`[data-share-link-id="${link!.id}"]`)).toContainText('열람')
  await section.locator(`[data-share-link-id="${link!.id}"]`).getByRole('button', { name: '철회' }).click()
  await expect(section.getByRole('status')).toContainText('링크를 철회했습니다')
  await expect(section.locator(`[data-share-link-id="${link!.id}"]`)).toContainText('철회됨')

  const closed = await visitor.page.goto(path)
  expect(closed!.status()).toBe(404)
  await expect(visitor.page.getByRole('heading', { level: 1, name: '링크를 열 수 없습니다' })).toBeVisible()
  expect((await visitor.api.raw('GET', `/api/v1/public${path.replace(/^\/s\//, '/share/')}`)).status()).toBe(404)
})
