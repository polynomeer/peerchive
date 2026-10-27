/**
 * C-10 운영 도구·계측(DELIVERY_PLAN §4.1 C-10·§6.1·§7 GC, ADR 0027). 빌드한 실제 서버로, 화면에서:
 * - 운영자 신고 대기열: 방금 들어온 신고 묶음에 처리 기한 배지("기한 여유 … 목표 72시간"), "기한 넘김만" 필터에는 나오지 않음.
 * - 주간 운영 시간: 이번 주 분야별 분을 적어 저장 → 내 기록 표에 보임 → 고쳐 저장.
 * - 커뮤니티 지표 화면: 신고·처리 시간·전환·운영 시간 합계·재지 않는 지표 이유, CSV 내보내기(id·이름·글 없음).
 * - 운영자가 아니면 세 화면 모두 404 문구.
 * - desktop과 360px(mobile project)에서 가로 스크롤 없음.
 * 준비(학교 인증·방·가입·글·신고)는 API로 합니다.
 */
import type { CommunityPostDto, SpaceDetailDto } from '../../web/shared/types/api'
import { createDisplayPersona, pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { grantOperator } from '../support/db'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

test('C-10: 신고 대기열 처리 기한 배지 → 주간 운영 시간 기록 → 커뮤니티 지표·CSV', async ({ newUser }) => {
  test.setTimeout(180_000)
  const author = await newUser('opsauthor')
  const reporter = await newUser('opsrep')
  const operator = await newUser('opsop')
  grantOperator(operator.email)
  const school = await pastTerm(author.api)
  const { domain } = schoolMailbox(school.schoolId)
  for (const [u, prefix] of [[author, 'a'], [reporter, 'r']] as const) await verifyByApi(u.api, school.schoolId, domain, prefix)
  const roomName = `E2E 운영방 ${rand(3)}`
  const room = await author.api.post<SpaceDetailDto>('/api/v1/community/spaces', { name: roomName, nameMode: 'display', joinPolicy: 'open' })
  // 표시명 방에서 쓰려면 표시명 프로필이 있어야 합니다(ADR 0030).
  await createDisplayPersona(author.api, 'opsauthor')
  await reporter.api.post(`/api/v1/community/spaces/${room.slug}/join`)
  const post = await author.api.post<CommunityPostDto>(`/api/v1/community/boards/${room.boards[0]!.id}/posts`, { title: `운영 글 ${rand(3)}`, body: 'E2E-SENTINEL 본문' })
  await reporter.api.post('/api/v1/reports', { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'spam' })

  // ── 운영자 아님: 404 문구 ──
  for (const p of ['/operator/ops-time', '/operator/community-metrics']) {
    await reporter.page.goto(p)
    await expect(reporter.page.getByRole('heading', { level: 1, name: '페이지를 찾을 수 없습니다' })).toBeVisible()
  }

  // ── 신고 대기열: 처리 기한 배지 ──
  const op = operator.page
  await op.goto('/operator')
  const group = op.locator('li').filter({ hasText: `커뮤니티 글 · ${roomName}` }).first()
  const badge = group.getByTestId('sla-badge')
  await expect(badge).toHaveAttribute('data-sla', 'ok')
  await expect(badge).toContainText('기한 여유')
  await expect(badge).toContainText('목표 72시간')
  await expectNoHorizontalScroll(op)
  await op.getByTestId('overdue-filter').click()
  await op.waitForURL(/overdue=1/)
  await expect(op.getByRole('link', { name: '기한 넘김만' })).toHaveAttribute('aria-current', 'page')
  await expect(op.locator('li').filter({ hasText: `커뮤니티 글 · ${roomName}` })).toHaveCount(0)

  // ── 주간 운영 시간 ──
  await op.goto('/operator')
  await op.getByRole('link', { name: '주간 운영 시간 기록' }).click()
  await op.waitForURL(/\/operator\/ops-time/)
  await expect(op.getByRole('heading', { level: 1, name: '주간 운영 시간' })).toBeVisible()
  const week = await op.getByLabel('주', { exact: true }).inputValue()
  expect(week).toMatch(/^\d{4}-W\d{2}$/)
  await op.getByLabel('신고 검토').fill('90')
  await op.getByLabel('큐레이션').fill('30')
  await expect(op.getByTestId('ops-total')).toContainText('2시간 0분')
  await op.getByLabel('메모(선택, 200자, 나만 봄)').fill('E2E 메모')
  await op.getByRole('button', { name: '저장' }).click()
  await expect(op.getByRole('status')).toContainText(`${week} 기록을 저장했습니다.`)
  const row = op.locator(`tr[data-week="${week}"]`)
  await expect(row).toContainText('2시간 0분')
  await op.getByLabel('신고 검토').fill('120')
  await op.getByRole('button', { name: '저장' }).click()
  await expect(row).toContainText('2시간 30분')
  await expectNoHorizontalScroll(op)

  // ── 커뮤니티 지표 ──
  await op.getByRole('link', { name: '커뮤니티 지표' }).first().click()
  await op.waitForURL(/\/operator\/community-metrics/)
  await expect(op.getByRole('heading', { level: 1, name: '커뮤니티 지표' })).toBeVisible()
  await expect(op.getByRole('heading', { name: '신고·처리 시간' })).toBeVisible()
  await expect(op.getByTestId('cm-moderation')).toContainText('기한 24시간(임시 숨김)·72시간(그 밖)')
  await expect(op.getByRole('heading', { name: '아카이브 전환' })).toBeVisible()
  await expect(op.getByTestId('cm-ops-time')).toContainText(week)
  await expect(op.getByRole('heading', { name: '재지 않는 지표' })).toBeVisible()
  await expect(op.getByText('방문(페이지 조회) 이벤트를 남기지 않아')).toBeVisible()
  await expect(op.getByText(roomName)).toHaveCount(0)
  await expectNoHorizontalScroll(op)

  // CSV: 집계만(id·이름·글 없음)
  const href = await op.getByTestId('metrics-export').getAttribute('href')
  const res = await operator.api.raw('GET', href!)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('text/csv')
  expect(res.headers()['content-disposition']).toMatch(/attachment; filename="peerchive-community-metrics-/)
  const csv = await res.text()
  expect(csv.split('\n')[0]).toBe('section,metric,dimension,value')
  for (const leak of [roomName, room.slug, post.id, 'E2E-SENTINEL', 'E2E 메모']) expect(csv).not.toContain(leak)
  expect(csv).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  // 운영자가 아니면 API 403
  expect((await reporter.api.raw('GET', '/api/v1/operator/metrics/community')).status()).toBe(403)
  expect((await reporter.api.raw('PUT', `/api/v1/operator/ops-time/${week}`, { minutes: { reports: 1 } })).status()).toBe(403)
})
