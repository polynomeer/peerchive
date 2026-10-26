/**
 * 시나리오 I. 취업용 읽기(DELIVERY_PLAN §5, T-14).
 * 로그인하지 않은 검토자가 /u/<handle>에서 대표 과제의 문제·개인 역할·근거를 찾습니다(근거 칩 → 공개 기록).
 * 페이지 HTML·응답 JSON·Open Graph·인쇄 보기에 이메일·체크인 메모·비공개 로그가 없습니다.
 */
import type { Response } from '@playwright/test'
import { featureCaseStudy, inviteAndAccept, progressLog, rand } from '../support/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('I: 익명 검토자가 공개 프로필에서 역할과 근거를 찾고, 비공개 정보는 어디에도 없다', async ({ newUser, anon }) => {
  const student = await newUser('ivy')
  const teammate = await newUser('ian')
  const pub = await publishCase(student, { stuck: true })
  await inviteAndAccept(student.api, teammate.api, pub.projectId, 'editor')
  const privateLog = `비공개 팀 메모 ${rand()}`
  await progressLog(student.api, pub.projectId, privateLog)
  const checkinNote = `체크인 메모 비공개 ${rand()}`
  await student.api.call('PUT', `/api/v1/projects/${pub.projectId}/checkins/me`, { timeBucket: 'lt5h', difficulty: 3, note: checkinNote })
  const { caseStudy } = await featureCaseStudy(student.api, pub.slug)
  const secrets = [student.email, teammate.email, privateLog, checkinNote, student.id]

  const reviewer = await anon()
  const page = reviewer.page
  const bodies: string[] = []
  const pending: Promise<void>[] = []
  page.on('response', (res: Response) => {
    const type = res.request().resourceType()
    if (type === 'document' || type === 'fetch' || type === 'xhr') {
      pending.push(res.text().then((t) => void bodies.push(`${res.url()}\n${t}`), () => undefined))
    }
  })

  const started = Date.now()
  await page.goto(`/u/${student.handle}`)
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(student.displayName) })).toBeVisible()
  const card = page.getByRole('article', { name: caseStudy.title })
  await expect(card.getByRole('heading', { level: 4, name: '문제와 결과' })).toBeVisible()
  await expect(card.getByRole('heading', { level: 4, name: '내 역할' })).toBeVisible()
  const role = card.locator('.case-section').filter({ has: page.getByRole('heading', { name: '내 역할' }) })
  await expect(role).toContainText(pub.claimText)
  const chip = role.locator('a.citation-chip').first()
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`/p/${pub.slug}`))
  await expect(page.getByText(pub.claimText).first()).toBeVisible()
  expect(Date.now() - started).toBeLessThan(90_000)

  // 인쇄 보기와 공개 JSON도 확인
  await page.goto(`/u/${student.handle}/print`)
  await expect(page.getByText(pub.claimText).first()).toBeVisible()
  await reviewer.api.get(`/api/v1/public/profiles/${student.handle}`)
  const readme = await reviewer.api.raw('GET', `/api/v1/public/profiles/${student.handle}/readme-card.md`)
  bodies.push(await readme.text())
  await page.goto(`/u/${student.handle}`)
  const og = await page.locator('meta[property^="og:"], meta[name="description"]').evaluateAll((els) => els.map((e) => e.getAttribute('content') ?? ''))
  bodies.push(og.join('\n'), await page.content())
  for (const path of [`/api/v1/public/profiles/${student.handle}`, `/api/v1/public/publications/${pub.slug}`]) {
    bodies.push(await (await reviewer.api.raw('GET', path)).text())
  }
  await Promise.all(pending)

  expect(bodies.length).toBeGreaterThan(4)
  const all = bodies.join('\n')
  for (const secret of secrets) expect(all, `공개 응답에 비공개 값이 있음: ${secret.slice(0, 3)}…`).not.toContain(secret)
  expect(all).not.toMatch(/[A-Za-z0-9._%+-]+@e2e-[0-9a-f]+\.example\.com/)
})
