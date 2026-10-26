import { defineConfig } from '@playwright/test'
import { SITE_ORIGIN } from './support/env'

/**
 * Peerchive E2E(Chromium만). 먼저 `pnpm --filter web build`(DB 컨테이너는 내린 상태)를 하고,
 * PostgreSQL을 띄운 뒤 `pnpm e2e`로 실행합니다. 자세한 절차는 README.md.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.PEERCHIVE_E2E_WORKERS ? Number(process.env.PEERCHIVE_E2E_WORKERS) : 3,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  use: {
    baseURL: SITE_ORIGIN,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { browserName: 'chromium', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
})
