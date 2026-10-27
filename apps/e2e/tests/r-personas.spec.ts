/**
 * 시나리오 R. 표시명과 실명의 분리(DELIVERY_PLAN §5.2, S-01, ADR 0028).
 * 학생이 설정 화면에서 표시명 프로필을 만듭니다. 연결이 꺼진 동안 로그인하지 않은 방문자가 받는 두 공개 프로필의 HTML(SSR payload 포함)·
 * Open Graph·인쇄 보기·공개 JSON·README 카드 어디에도 상대 프로필의 handle·이름·id·소개가 없습니다. 연결을 켜면 양쪽에 서로의 링크가 보이고,
 * 끄면 다음 요청부터 사라집니다.
 */
import type { Page, Response } from '@playwright/test'
import type { MyPersonasDto } from '../../web/shared/types/api'
import { rand } from '../support/api'
import { expect, test } from '../support/fixtures'

/** 페이지를 열며 받은 문서·fetch 응답 본문 + 최종 HTML + OG/description 메타. */
async function capture(page: Page, path: string): Promise<string> {
  const bodies: string[] = []
  const pending: Promise<void>[] = []
  const onResponse = (res: Response) => {
    const type = res.request().resourceType()
    if (type === 'document' || type === 'fetch' || type === 'xhr') pending.push(res.text().then((t) => void bodies.push(t), () => undefined))
  }
  page.on('response', onResponse)
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const meta = await page.locator('meta[property^="og:"], meta[name="description"]').evaluateAll((els) => els.map((e) => e.getAttribute('content') ?? ''))
  bodies.push(meta.join('\n'), await page.title(), await page.content())
  await Promise.all(pending)
  page.off('response', onResponse)
  return bodies.join('\n')
}

test('R: 연결이 꺼져 있으면 두 공개 프로필 어디에도 상대 정보가 없고, 켜면 서로 링크, 끄면 다시 사라진다', async ({ newUser, anon }) => {
  const student = await newUser('rina')
  const realHeadline = `실명 소개 ${rand()}`
  await student.api.patch('/api/v1/me/profile', { headline: realHeadline })
  const display = { handle: `night-${rand()}`, name: `밤의개발자${rand(2)}`, headline: `표시명 소개 ${rand()}` }

  // 설정 화면에서 표시명 프로필 만들기
  const page = student.page
  await page.goto('/settings/personas')
  await page.getByLabel('핸들 (필수)').fill(display.handle)
  await page.getByLabel('표시명 (필수)').fill(display.name)
  await page.getByLabel('한 줄 소개 (선택)').fill(display.headline)
  await page.getByRole('button', { name: '만들기' }).click()
  await expect(page.getByRole('status').filter({ hasText: '표시명 프로필을 만들었습니다' })).toBeVisible()
  await expect(page.getByText('꺼져 있습니다', { exact: true })).toBeVisible()
  const mine = await student.api.get<MyPersonasDto>('/api/v1/me/personas')
  const realId = mine.personas.find((p) => p.kind === 'real')!.id
  const displayId = mine.personas.find((p) => p.kind === 'display')!.id

  const realSide = [student.handle, student.displayName, realId, realHeadline, student.id]
  const displaySide = [display.handle, display.name, displayId, display.headline]
  const visitor = await anon()

  async function everything(handle: string): Promise<string> {
    const parts = [await capture(visitor.page, `/u/${handle}`), await capture(visitor.page, `/u/${handle}/print`)]
    for (const path of [`/api/v1/public/profiles/${handle}`, `/api/v1/public/profiles/${handle}/readme-card.md`, `/api/v1/profiles/${handle}`]) {
      const res = await visitor.api.raw('GET', path)
      expect(res.status(), path).toBe(200)
      parts.push(await res.text())
    }
    return parts.join('\n')
  }
  async function expectSeparated(label: string) {
    const real = await everything(student.handle)
    const disp = await everything(display.handle)
    expect(real).toContain(realHeadline)
    expect(disp).toContain(display.headline)
    for (const v of displaySide) expect(real, `${label}: 실명 프로필에 표시명 정보 ${v.slice(0, 4)}…`).not.toContain(v)
    for (const v of realSide) expect(disp, `${label}: 표시명 프로필에 실명 정보 ${v.slice(0, 4)}…`).not.toContain(v)
  }

  await expectSeparated('꺼짐')

  // 연결 켜기(확인 대화상자) → 양쪽에 서로의 링크
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: '연결 켜기' }).click()
  await expect(page.getByRole('status').filter({ hasText: '서로의 링크를 보입니다' })).toBeVisible()
  await visitor.page.goto(`/u/${student.handle}`)
  await expect(visitor.page.getByRole('link', { name: `${display.name} @${display.handle}` })).toBeVisible()
  await visitor.page.goto(`/u/${display.handle}`)
  await expect(visitor.page.getByText('표시명 프로필', { exact: true })).toBeVisible()
  const back = visitor.page.getByRole('link', { name: `${student.displayName} @${student.handle}` })
  await expect(back).toBeVisible()
  await back.click()
  await expect(visitor.page).toHaveURL(new RegExp(`/u/${student.handle}$`))
  await visitor.page.goto(`/u/${display.handle}/print`)
  await expect(visitor.page.getByText(`/u/${student.handle}`).first()).toBeVisible()
  // 켜져 있어도 상대 페르소나 id·소개는 싣지 않음
  const linked = await everything(display.handle)
  for (const v of [realId, realHeadline, student.id]) expect(linked).not.toContain(v)

  // 다시 끄기 → 다음 요청부터 0건
  await page.getByRole('button', { name: '연결 끄기' }).click()
  await expect(page.getByRole('status').filter({ hasText: '연결을 껐습니다' })).toBeVisible()
  await expectSeparated('다시 꺼짐')
})
