/**
 * C-02 커뮤니티 공간(DELIVERY_PLAN §4.1, ADR 0019). 화면으로:
 * 학교 인증한 사람이 방 만들기(이름 표시 방식 선택, 초대 전용) → 초대 링크 → 같은 학교 인증한 다른 사람이 수락 → 방장이 나가면
 * 남은 멤버가 방장이 됨(승계). 커뮤니티 API·페이지는 noindex이고 비로그인 API는 401(화면은 404, community-visibility.spec.ts), 공개 검색에는 방 이름이 나오지 않음.
 * C-03 이름 표시 방식(ADR 0020): 방장이 화면에서 변경 예약 → 멤버에게 배너·알림 → (적용 시뮬레이션: 예약 시각을 7일 앞당기고 worker 적용 명령)
 * → 새 방식·적용 알림·변경 이력.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { applyNameModeChangeNow } from '../support/db'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

test('C-02: 방 만들기 → 초대 → 수락 → 방장 나가기(승계)', async ({ newUser, anon }) => {
  const owner = await newUser('roomowner')
  const guest = await newUser('guest')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(owner.api, school.schoolId, domain, 'o')
  await verifyByApi(guest.api, school.schoolId, domain, 'g')
  const roomName = `E2E 동기방 ${rand(3)}`

  // 방 만들기(화면)
  const page = owner.page
  await page.goto('/community')
  await expect(page.getByRole('heading', { level: 1, name: '커뮤니티' })).toBeVisible()
  // 예약어는 거부
  await page.getByLabel('방 이름 (필수)').fill('공식 컴공방')
  await page.getByRole('button', { name: '방 만들기' }).click()
  await expect(page.getByText('사용자 방 이름에 쓸 수 없습니다')).toBeVisible()
  await page.getByLabel('방 이름 (필수)').fill(roomName)
  await page.getByLabel('학교', { exact: true }).selectOption({ label: `${school.schoolName} 인증 계정만` })
  await page.getByLabel('표시명', { exact: true }).check()
  await page.getByLabel('가입 방식').selectOption('invite')
  await page.getByLabel('찾기', { exact: true }).selectOption('unlisted')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: '방 만들기' }).click()
  await page.waitForURL(/\/community\/s\/[a-z0-9]{10}$/)
  const slug = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByRole('heading', { level: 1, name: roomName })).toBeVisible()
  await expect(page.getByText('이 공간의 이름 표시 방식: 표시명')).toBeVisible()
  await expect(page.getByRole('link', { name: '게시판', exact: true })).toBeVisible()
  await expect(page.getByText('공식', { exact: true })).toHaveCount(0)
  await expectNoHorizontalScroll(page)

  // 멤버가 아니면 초대 전용 방은 찾을 수 없음(404)
  await guest.page.goto(`/community/s/${slug}`)
  await expect(guest.page.getByRole('heading', { level: 1, name: '공간을 찾을 수 없습니다' })).toBeVisible()
  expect((await guest.api.raw('GET', `/api/v1/community/spaces/${slug}`)).status()).toBe(404)

  // 초대 링크(화면) → 수락(화면)
  await page.getByRole('button', { name: '초대 링크 만들기' }).click()
  await expect(page.getByRole('status').filter({ hasText: '초대 링크를 만들었습니다' })).toBeVisible()
  const inviteUrl = await page.getByLabel('새 초대 링크').inputValue()
  expect(new URL(inviteUrl).pathname).toMatch(/^\/community\/invite\/[A-Za-z0-9_-]{20,}$/)
  await guest.page.goto(inviteUrl)
  await expect(guest.page.getByRole('heading', { level: 2, name: roomName })).toBeVisible()
  await guest.page.getByRole('button', { name: '초대 수락' }).click()
  await guest.page.waitForURL(new RegExp(`/community/s/${slug}$`))
  await expect(guest.page.getByRole('heading', { level: 1, name: roomName })).toBeVisible()
  await expect(guest.page.getByRole('button', { name: '나가기', exact: true })).toBeVisible()
  // 초대는 한 번만
  const reused = await guest.api.raw('POST', '/api/v1/community/invitations/accept', { token: new URL(inviteUrl).pathname.split('/').pop() })
  expect(reused.status()).toBe(410)

  // 방장 화면: 멤버 목록에 손님
  await page.reload()
  await expect(page.getByRole('region', { name: '멤버', exact: true })).toContainText(guest.displayName)

  // 방장 나가기 → 손님이 방장
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: '방장 넘기고 나가기' }).click()
  await page.waitForURL(/\/community(\?|$)/)
  await guest.page.reload()
  await expect(guest.page.getByRole('button', { name: '방장 넘기고 나가기' })).toBeVisible()
  await expect(guest.page.getByRole('button', { name: '방 보관하기' })).toBeVisible()
  await expectNoHorizontalScroll(guest.page)

  // 비공개 경계: noindex, 비로그인 401, 공개 검색에 방 이름 없음
  const api = await guest.api.raw('GET', `/api/v1/community/spaces/${slug}`)
  expect(api.headers()['x-robots-tag']).toBe('noindex, nofollow, noarchive')
  const html = await guest.page.request.get(`/community/s/${slug}`)
  expect(html.headers()['x-robots-tag']).toBe('noindex, nofollow, noarchive')
  const visitor = await anon()
  const denied = await visitor.api.raw('GET', `/api/v1/community/spaces/${slug}`)
  expect(denied.status()).toBe(401)
  expect(await denied.text()).not.toContain(roomName)
  const search = await visitor.api.raw('GET', `/api/v1/public/search?q=${encodeURIComponent(roomName)}`)
  expect(await search.text()).not.toContain(slug)
  expect(((await search.json()) as { results: unknown[] }).results).toEqual([])
})

test('C-03: 방장이 이름 표시 방식 변경 예약 → 멤버 배너·알림 → 적용', async ({ newUser }) => {
  const owner = await newUser('modeowner')
  const member = await newUser('modemember')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(owner.api, school.schoolId, domain, 'o')
  await verifyByApi(member.api, school.schoolId, domain, 'm')
  const roomName = `E2E 모드방 ${rand(3)}`
  // 준비(API): 표시명 자유 가입 방 + 멤버 가입
  const room = await owner.api.post<{ slug: string }>('/api/v1/community/spaces', { name: roomName, nameMode: 'display', joinPolicy: 'open' })
  await member.api.post(`/api/v1/community/spaces/${room.slug}/join`)

  // 방장: 화면에서 익명으로 바꾸기 예약
  const page = owner.page
  await page.goto(`/community/s/${room.slug}`)
  const section = page.getByRole('region', { name: '이름 표시 방식', exact: true })
  await expect(section).toContainText('지금: 표시명')
  await expect(section).toContainText('아직 바꾼 적이 없습니다.')
  await section.getByLabel('익명으로 바꾸기').check()
  await expectNoHorizontalScroll(page)
  page.once('dialog', (d) => void d.accept())
  await section.getByRole('button', { name: '변경 예약' }).click()
  await expect(page.getByRole('status').filter({ hasText: '이름 표시 방식 변경을 예약했습니다' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '7일 뒤 이름 표시 방식이 익명으로 바뀝니다. 이미 쓴 글은 바뀌지 않습니다.' })).toBeVisible()
  await expect(section.getByRole('button', { name: '변경 예약 취소' })).toBeVisible()
  // 한 번에 하나: API로 또 예약하면 409
  expect((await owner.api.raw('POST', `/api/v1/community/spaces/${room.slug}/name-mode-changes`, { toMode: 'real' })).status()).toBe(409)
  // 멤버는 예약할 수 없음(403)
  expect((await member.api.raw('POST', `/api/v1/community/spaces/${room.slug}/name-mode-changes`, { toMode: 'real' })).status()).toBe(403)

  // 멤버: 배너·알림
  const mp = member.page
  await mp.goto(`/community/s/${room.slug}`)
  await expect(mp.getByText('이 공간의 이름 표시 방식: 표시명')).toBeVisible()
  await expect(mp.getByRole('status').filter({ hasText: '7일 뒤 이름 표시 방식이 익명으로 바뀝니다. 이미 쓴 글은 바뀌지 않습니다.' })).toBeVisible()
  await expect(mp.getByRole('button', { name: '변경 예약' })).toHaveCount(0)
  await expectNoHorizontalScroll(mp)
  await mp.goto('/community')
  await expect(mp.getByRole('link', { name: /커뮤니티 알림 \(읽지 않음 1개\)/ })).toBeVisible()
  await mp.getByRole('link', { name: /커뮤니티 알림/ }).click()
  await expect(mp.getByRole('heading', { level: 1, name: '커뮤니티 알림' })).toBeVisible()
  await expect(mp.getByText('이름 표시 방식 변경 예약')).toBeVisible()
  await expect(mp.getByRole('link', { name: roomName })).toBeVisible()
  await expect(mp.getByText('표시명에서 익명으로 바뀔 예정입니다. 이미 쓴 글은 바뀌지 않습니다.')).toBeVisible()
  await expectNoHorizontalScroll(mp)

  // 적용(시뮬레이션): 예약 시각을 7일 앞당기고 worker 적용 명령 실행
  expect(await applyNameModeChangeNow(room.slug)).toBe(1)
  await mp.goto(`/community/s/${room.slug}`)
  await expect(mp.getByText('이 공간의 이름 표시 방식: 익명')).toBeVisible()
  await expect(mp.getByText('이미 쓴 글은 바뀌지 않습니다.')).toHaveCount(0)
  const history = mp.getByRole('region', { name: '이름 표시 방식', exact: true })
  await expect(history).toContainText('표시명 → 익명 · 적용됨')
  await mp.goto('/community/notices')
  await expect(mp.getByText('이름 표시 방식 변경 적용')).toBeVisible()
  await mp.getByRole('button', { name: '모두 읽음' }).click()
  await expect(mp.getByRole('status').filter({ hasText: '모두 읽음으로 표시했습니다.' })).toBeVisible()
  // 방장 화면: 다시 예약 가능(지금 방식 익명 기준 선택지)
  await page.reload()
  await expect(section.getByLabel('표시명으로 바꾸기')).toBeVisible()
  await expect(section.getByLabel('익명으로 바꾸기')).toHaveCount(0)
})
