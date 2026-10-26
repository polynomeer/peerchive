/**
 * 접근성·레이아웃 smoke(axe 같은 의존성 없이 기본 규칙만). 주요 화면마다:
 * - 보이는 h1이 정확히 하나
 * - 보이는 입력 칸(input/select/textarea)에 접근 가능한 이름(label·aria-label·aria-labelledby·title)이 있음
 * - Tab으로 옮긴 포커스가 눈에 보임(outline 또는 box-shadow), 첫 Tab은 "본문으로 건너뛰기"
 * - 가로 스크롤 없음(document.documentElement.scrollWidth ≤ innerWidth) — mobile 360px에서 특히 의미 있음
 * 실패는 soft assertion으로 모아 화면별로 보여 줍니다.
 */
import type { Page } from '@playwright/test'
import { addClaim, createProject, featureCaseStudy, progressLog, rand } from '../support/api'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

async function unlabelledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const style = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const named = (el: HTMLElement) => {
      if (el.getAttribute('aria-label')?.trim()) return true
      const by = el.getAttribute('aria-labelledby')
      if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true
      if ((el as HTMLInputElement).labels && [...(el as HTMLInputElement).labels!].some((l) => l.textContent?.trim())) return true
      if (el.getAttribute('title')?.trim()) return true
      return false
    }
    return [...document.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea')]
      .filter((el) => visible(el) && !el.closest('dialog:not([open])'))
      .filter((el) => !named(el))
      .map((el) => `${el.tagName.toLowerCase()}#${el.id || '?'}[name=${el.getAttribute('name') ?? ''}]`)
  })
}

async function focusRing(page: Page): Promise<{ tag: string; text: string; visible: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return { tag: 'body', text: '', visible: false }
    const s = getComputedStyle(el)
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
    const shadow = s.boxShadow !== 'none'
    return { tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 30), visible: outline || shadow }
  })
}

async function checkPage(page: Page, path: string): Promise<void> {
  await test.step(path, async () => {
    const res = await page.goto(path)
    expect.soft(res?.status(), `${path} 응답`).toBeLessThan(400)
    await page.waitForLoadState('networkidle')
    const h1 = page.locator('h1:visible')
    expect.soft(await h1.count(), `${path}: 보이는 h1 수 (${(await h1.allTextContents()).join(' | ')})`).toBe(1)
    expect.soft(await unlabelledControls(page), `${path}: 이름 없는 입력 칸`).toEqual([])
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Tab')
    const first = await focusRing(page)
    expect.soft(first.text, `${path}: 첫 Tab은 건너뛰기 링크`).toBe('본문으로 건너뛰기')
    expect.soft(first.visible, `${path}: 첫 Tab 포커스 표시`).toBe(true)
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab')
      const ring = await focusRing(page)
      expect.soft(ring.visible, `${path}: Tab ${i + 2}번째 포커스(${ring.tag} "${ring.text}") 표시`).toBe(true)
    }
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
    expect.soft(innerWidth, `${path}: 뷰포트 너비`).toBe(test.info().project.use.viewport?.width)
    expect.soft(scrollWidth, `${path}: 가로 스크롤(scrollWidth ${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth)
  })
}

test('접근성·레이아웃 smoke: 주요 화면', async ({ newUser, anon }) => {
  const owner = await newUser('ally')
  const pub = await publishCase(owner, { stuck: true, withPdf: true, milestones: ['기획', '구현'] })
  await featureCaseStudy(owner.api, pub.slug)
  const project = await createProject(owner.api, { title: `작업 중 과제 ${rand()}` })
  const log = await progressLog(owner.api, project.id, `작업 기록 ${rand()}`)
  await addClaim(owner.api, project.id, `역할 선언 ${rand()}`, [{ kind: 'log', id: log.id }])

  const visitor = await anon()
  for (const path of ['/', '/login', `/p/${pub.slug}`, `/c/${pub.courseId}`, `/u/${owner.handle}`, `/search?q=${encodeURIComponent('CORS')}`]) {
    await checkPage(visitor.page, path)
  }
  for (const path of ['/projects', `/projects/${project.id}`, `/projects/${pub.projectId}/publish`, '/consents', '/portfolio', '/onboarding', '/settings/affiliations']) {
    await checkPage(owner.page, path)
  }
  await expectNoHorizontalScroll(owner.page)
})
