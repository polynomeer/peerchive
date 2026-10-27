/**
 * C-05 커뮤니티 열람 범위·검색엔진 비노출(DELIVERY_PLAN §4.1 C-05, §7 GC 게이트, ADR 0021). 빌드한 실제 서버로:
 * - 비로그인 방문자·링크 미리보기 봇: 방 주소가 어떤 방이든 같은 404 고정 HTML(방 이름·Nuxt payload·OG 없음, robots meta).
 * - 다른 학교 인증 사용자: 앱 안의 "공간을 찾을 수 없습니다"(HTTP 404), 페이지 소스에 방 이름 없음.
 * - 멤버: 방은 보이지만 문서 제목은 고정("Peerchive 커뮤니티"), og·description meta 없음, noindex·no-store·no-referrer 헤더.
 * - 로그아웃하면 화면에 남은 방 데이터를 버림(뒤로 가기·같은 주소로 돌아가도 방 이름 없음).
 * - robots.txt: 파일럿 기본(색인 꺼짐)은 전부 막음.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, test } from '../support/fixtures'

const ROBOTS = 'noindex, nofollow, noarchive'
const BOTS = [
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
]

test('C-05: 비로그인·봇·다른 학교는 404, 멤버 화면도 제목·OG에 방 이름 없음, 로그아웃하면 방 데이터가 남지 않음', async ({ newUser, anon }) => {
  const owner = await newUser('visowner')
  const stranger = await newUser('visstranger')
  const home = await pastTerm(owner.api)
  const away = await pastTerm(stranger.api)
  await verifyByApi(owner.api, home.schoolId, schoolMailbox(home.schoolId).domain, 'o')
  await verifyByApi(stranger.api, away.schoolId, schoolMailbox(away.schoolId).domain, 's')
  const roomName = `E2E 비공개방 ${rand(3)}`
  const description = `E2E 소개 ${rand(3)}`
  const room = await owner.api.post<{ slug: string }>('/api/v1/community/spaces', {
    name: roomName,
    description,
    schoolId: home.schoolId,
    nameMode: 'display',
    joinPolicy: 'open',
    discovery: 'listed',
  })
  const url = `/community/s/${room.slug}`

  // ── 비로그인: 실제 방·없는 방·초대 주소 모두 같은 404 고정 HTML ──
  const visitor = await anon()
  const bodies = new Set<string>()
  for (const path of [url, '/community/s/zzzzzzzzzz', '/community', '/community/invite/abcdefghijklmnopqrstuvwxyz']) {
    const res = await visitor.page.request.get(path)
    expect(res.status(), path).toBe(404)
    expect(res.headers()['x-robots-tag']).toBe(ROBOTS)
    expect(res.headers()['cache-control']).toBe('no-store')
    expect(res.headers()['referrer-policy']).toBe('no-referrer')
    expect(res.headers()['set-cookie']).toBeUndefined()
    bodies.add(await res.text())
  }
  expect(bodies.size).toBe(1)
  const [fixed] = [...bodies]
  expect(fixed).not.toContain(roomName)
  expect(fixed).not.toContain(description)
  expect(fixed).not.toMatch(/__NUXT|og:|name="description"/)
  expect(fixed).toContain(`<meta name="robots" content="${ROBOTS}">`)
  // 화면으로 열어도 같은 404 페이지
  const response = await visitor.page.goto(url)
  expect(response?.status()).toBe(404)
  await expect(visitor.page.getByRole('heading', { level: 1, name: '페이지를 찾을 수 없습니다' })).toBeVisible()
  await expect(visitor.page.locator('meta[name="robots"]')).toHaveAttribute('content', ROBOTS)
  // API는 401(모든 주소에 같은 본문)
  const denied = await visitor.api.raw('GET', `/api/v1/community/spaces/${room.slug}`)
  expect(denied.status()).toBe(401)
  expect(denied.headers()['x-robots-tag']).toBe(ROBOTS)
  expect(await denied.text()).not.toContain(roomName)

  // ── 링크 미리보기 봇: 같은 404, 본문 미리보기 없음 ──
  for (const ua of BOTS) {
    const res = await visitor.page.request.get(url, { headers: { 'user-agent': ua } })
    expect(res.status(), ua).toBe(404)
    expect(await res.text(), ua).toBe(fixed)
  }

  // ── 다른 학교 인증 사용자: 앱 안의 404, 소스에 방 이름 없음 ──
  const strangerRes = await stranger.page.goto(url)
  expect(strangerRes?.status()).toBe(404)
  await expect(stranger.page.getByRole('heading', { level: 1, name: '공간을 찾을 수 없습니다' })).toBeVisible()
  const strangerSource = await strangerRes!.text()
  expect(strangerSource).not.toContain(roomName)
  expect(strangerSource).not.toContain(description)
  expect(strangerRes!.headers()['x-robots-tag']).toBe(ROBOTS)
  await expect(stranger.page.locator('meta[name="robots"]')).toHaveAttribute('content', ROBOTS)
  await expect(stranger.page).toHaveTitle('Peerchive 커뮤니티')
  expect((await stranger.api.raw('GET', `/api/v1/community/spaces/${room.slug}`)).status()).toBe(404)

  // ── 멤버(방장): 방은 보이지만 제목·OG·description에 방 이름 없음 ──
  const page = owner.page
  const ownerRes = await page.goto(url)
  expect(ownerRes?.status()).toBe(200)
  expect(ownerRes!.headers()['x-robots-tag']).toBe(ROBOTS)
  expect(ownerRes!.headers()['cache-control']).toBe('no-store')
  expect(ownerRes!.headers()['referrer-policy']).toBe('no-referrer')
  await expect(page.getByRole('heading', { level: 1, name: roomName })).toBeVisible()
  await expect(page).toHaveTitle('Peerchive 커뮤니티')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', ROBOTS)
  await expect(page.locator('meta[property^="og:"], meta[name^="twitter:"], meta[name="description"]')).toHaveCount(0)
  const head = await page.locator('head').innerHTML()
  expect(head).not.toContain(roomName)
  expect(head).not.toContain(description)

  // ── 로그아웃: 앱을 새로 불러 남은 방 데이터를 버림 ──
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '커뮤니티', exact: true }).click()
  await page.waitForURL(/\/community$/)
  await page.getByRole('button', { name: '로그아웃' }).click()
  await page.waitForURL(/\/login$/)
  expect(await page.content()).not.toContain(roomName)
  expect(await page.evaluate(() => document.getElementById('__NUXT_DATA__')?.textContent ?? '')).not.toContain(roomName)
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: '페이지를 찾을 수 없습니다' })).toBeVisible()
  expect(await page.content()).not.toContain(roomName)
  const after = await page.goto(url)
  expect(after?.status()).toBe(404)
  expect(await page.content()).not.toContain(roomName)

  // ── robots.txt(파일럿 기본: 색인 꺼짐 → 전부 막음) ──
  const robots = await visitor.page.request.get('/robots.txt')
  expect(robots.status()).toBe(200)
  expect(await robots.text()).toContain('User-agent: *\nDisallow: /\n')
})
