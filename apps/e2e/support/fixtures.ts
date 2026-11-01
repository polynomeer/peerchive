/**
 * 테스트 fixture: 사용자마다 새 browser context를 만들고 실제 로그인 흐름을 거칩니다.
 *
 *   로그인 화면에서 링크 요청 → dev-console 메일(서버 로그)에서 링크 읽기 → `/auth/verify#token=…` 열기
 *   → [로그인 계속하기] → (처음이면) 온보딩에서 핸들·표시 이름 저장 → /projects
 *
 * 이메일·핸들은 무작위라 남은 데이터와 겹치지 않습니다. 익명 방문자는 `anon()`으로 쿠키 없는 context를 씁니다.
 */
import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test'
import type { MeDto } from '../../web/shared/types/api'
import { Api, rand } from './api'
import { resetLoginIpRateLimit } from './db'
import { mailCount, waitForMagicLink } from './mail'

export interface E2eUser {
  email: string
  handle: string
  displayName: string
  id: string
  context: BrowserContext
  page: Page
  api: Api
}

/** 로그인 화면에서 링크를 받아 로그인합니다(온보딩 포함). */
export async function login(page: Page, email: string, profile?: { handle: string; displayName: string }): Promise<void> {
  await resetLoginIpRateLimit()
  const before = mailCount(email)
  await page.goto('/login')
  // 하이드레이션 전에 입력하면 값이 지워지므로, 버튼이 켜질 때(onMounted)까지 기다린 뒤 입력합니다.
  const submit = page.getByRole('button', { name: '로그인 링크 받기' })
  await expect(submit).toBeEnabled()
  await page.getByLabel('이메일').fill(email)
  await submit.click()
  await expect(page.getByRole('status').filter({ hasText: '메일을 확인하세요' })).toBeVisible()
  const link = await waitForMagicLink(email, before)
  expect(new URL(link).pathname).toBe('/auth/verify')
  await page.goto(link)
  await page.getByRole('button', { name: '로그인 계속하기' }).click()
  await page.waitForURL(/\/(onboarding|projects)(\?|$)/)
  if (new URL(page.url()).pathname === '/onboarding') {
    if (!profile) throw new Error('새 계정인데 프로필 정보가 없습니다')
    await page.getByLabel('핸들 (필수)').fill(profile.handle)
    await page.getByLabel('표시 이름 (필수)').fill(profile.displayName)
    await page.getByRole('button', { name: '저장' }).click()
    await page.waitForURL(/\/projects$/)
  }
}

type ContextFactory = (options?: BrowserContextOptions) => Promise<BrowserContext>

interface Fixtures {
  /** 프로젝트 설정(뷰포트 등)을 그대로 쓰는 새 context. */
  newContext: ContextFactory
  /** 새 사용자를 만들고 로그인합니다. */
  newUser: (label?: string) => Promise<E2eUser>
  /** 로그인하지 않은 방문자. */
  anon: () => Promise<{ context: BrowserContext; page: Page; api: Api }>
}

export const test = base.extend<Fixtures>({
  newContext: async ({ browser, contextOptions, viewport, isMobile, hasTouch, deviceScaleFactor, baseURL, locale, timezoneId }, use) => {
    const contexts: BrowserContext[] = []
    await use(async (options = {}) => {
      const context = await (browser as Browser).newContext({
        ...contextOptions,
        viewport,
        isMobile,
        hasTouch,
        deviceScaleFactor,
        baseURL,
        locale,
        timezoneId,
        ...options,
      })
      contexts.push(context)
      return context
    })
    for (const context of contexts) await context.close()
  },
  newUser: async ({ newContext }, use) => {
    await use(async (label = 'user') => {
      const context = await newContext()
      const page = await context.newPage()
      const id = rand(5)
      const email = `${label[0]}${id}@e2e-${id}.example.com`
      const handle = `e2e-${label}-${id}`.slice(0, 30)
      const displayName = `${label}-${id}`
      await login(page, email, { handle, displayName })
      const api = new Api(context.request)
      const me = await api.get<MeDto>('/api/v1/me')
      return { email, handle, displayName, id: me.id, context, page, api }
    })
  },
  anon: async ({ newContext }, use) => {
    await use(async () => {
      const context = await newContext()
      const page = await context.newPage()
      return { context, page, api: new Api(context.request) }
    })
  },
})

export { expect }

/** 가로 스크롤이 없는지(모바일 360px 기준). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth, `scrollWidth ${scrollWidth} > innerWidth ${innerWidth} (${page.url()})`).toBeLessThanOrEqual(innerWidth)
}
