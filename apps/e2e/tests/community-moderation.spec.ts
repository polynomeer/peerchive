/**
 * C-06 신고 누적 임시 숨김·제재 요청·운영자 작성자 확인·이용 제한(DELIVERY_PLAN §4.1 C-06·§5.1 M, ADR 0023). 빌드한 실제 서버로, 화면에서:
 * - 익명 방에서 서로 다른 인증 멤버 셋이 한 글을 신고(한 사람은 신고 대화상자로) → 모두에게 "운영 검토 중", 작성자에게는 본인 안내.
 * - 운영자 대기열 맨 앞에 "임시 숨김 · 우선 검토" → 기각(복원) → 글이 다시 보임.
 * - 방장은 작성자를 모른 채 제재 요청(화면·응답에 작성자 식별자 없음).
 * - 운영자가 사유를 기록하고 작성자 확인 → 이 방 범위 쓰기 기간 제한 발급 → 그 사람은 이 방에서 못 쓰고 다른 방에서는 씀. 방장 화면에는 "제한 1건"뿐.
 * - 360px(mobile project)에서 가로 스크롤 없음.
 * 준비(학교 인증·방 만들기·가입·글 쓰기)는 API로 합니다.
 */
import type { BoardPostsDto, CommunityPostDto, SpaceDetailDto } from '../../web/shared/types/api'
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { grantOperator } from '../support/db'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

test('C-06: 신고 셋 → 운영 검토 중 → 운영자 복원, 방장 제재 요청(작성자 모름) → 작성자 확인 → 이 방 쓰기 제한(다른 방은 씀)', async ({ newUser }) => {
  // 사용자 다섯의 실제 로그인 + 운영자 화면 여러 개라 기본 90초보다 오래 걸립니다.
  test.setTimeout(240_000)
  const owner = await newUser('modowner')
  const author = await newUser('modauthor')
  const r1 = await newUser('modrep1')
  const r2 = await newUser('modrep2')
  const operator = await newUser('modop')
  grantOperator(operator.email)
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  // 메일 로그는 주소를 첫 글자 + 도메인으로 가리므로 사람마다 첫 글자를 다르게 합니다.
  for (const [u, prefix] of [[owner, 'o'], [author, 'a'], [r1, 'b'], [r2, 'c']] as const) await verifyByApi(u.api, school.schoolId, domain, prefix)
  const roomName = `E2E 제재방 ${rand(3)}`
  const room = await owner.api.post<SpaceDetailDto>('/api/v1/community/spaces', { name: roomName, nameMode: 'anonymous', joinPolicy: 'open' })
  const other = await owner.api.post<SpaceDetailDto>('/api/v1/community/spaces', { name: `E2E 다른방 ${rand(3)}`, nameMode: 'anonymous', joinPolicy: 'open' })
  for (const u of [author, r1, r2]) await u.api.post(`/api/v1/community/spaces/${room.slug}/join`)
  await author.api.post(`/api/v1/community/spaces/${other.slug}/join`)
  const title = `문제 글 ${rand(3)}`
  const post = await author.api.post<CommunityPostDto>(`/api/v1/community/boards/${room.boards[0]!.id}/posts`, { title, body: '익명으로 쓴 본문' })

  // ── 신고 셋(한 명은 화면 대화상자: 커뮤니티 안내가 보임) ──
  await r1.page.goto(`/community/p/${post.id}`)
  await r1.page.locator('article').getByRole('button', { name: '신고하기' }).click()
  const dialog = r1.page.getByRole('dialog', { name: '신고하기' })
  await expect(dialog.getByTestId('community-report-hint')).toContainText('임시로 가려집니다')
  await dialog.getByLabel('괴롭힘·비방').check()
  await dialog.getByRole('button', { name: '신고 보내기' }).click()
  await expect(dialog.getByRole('status')).toContainText('신고가 접수되었습니다')
  await dialog.getByRole('button', { name: '닫기' }).click()
  for (const u of [r2, owner]) {
    await u.api.post('/api/v1/reports', { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'harassment' })
  }
  await r1.page.reload()
  await expect(r1.page.getByRole('heading', { level: 1, name: '신고가 모여 운영 검토 중인 글입니다' })).toBeVisible()
  await expect(r1.page.getByText('익명으로 쓴 본문')).toHaveCount(0)
  await expectNoHorizontalScroll(r1.page)
  // 작성자: 본인 안내(신고자·신고 수 없음)
  await author.page.goto(`/community/p/${post.id}`)
  await expect(author.page.getByTestId('own-review-notice')).toContainText('운영 검토 중')

  // ── 운영자: 우선 검토 → 기각(복원) ──
  await operator.page.goto('/operator')
  const group = operator.page.locator('li').filter({ hasText: `커뮤니티 글 · ${roomName}` }).first()
  await expect(group.getByTestId('auto-hidden-badge')).toBeVisible()
  await group.getByRole('link', { name: `커뮤니티 글 · ${roomName}` }).click()
  await operator.page.waitForURL(/\/operator\/reports\//)
  await expect(operator.page.getByTestId('auto-hidden-guide')).toBeVisible()
  await operator.page.getByLabel('기각 메모(필수)').fill('E2E: 정상 글로 판단, 복원')
  await operator.page.getByRole('button', { name: '기각하기' }).click()
  await expect(operator.page.getByText('기각했습니다.')).toBeVisible()
  await r1.page.reload()
  await expect(r1.page.getByRole('heading', { level: 1, name: title })).toBeVisible()

  // ── 방장: 작성자를 모른 채 제재 요청 ──
  await owner.page.goto(`/community/p/${post.id}`)
  await owner.page.locator('article').getByRole('button', { name: '제재 요청' }).click()
  const req = owner.page.getByRole('dialog', { name: '제재 요청' })
  await req.getByLabel('괴롭힘·비방').check()
  await req.getByLabel('설명').fill('반복된 비방 글입니다')
  await req.getByRole('button', { name: '요청 보내기' }).click()
  await expect(req.getByRole('status')).toContainText('제재 요청을 보냈습니다')
  await req.getByRole('button', { name: '닫기' }).click()
  await owner.page.goto(`/community/s/${room.slug}`)
  await expect(owner.page.getByTestId('sanction-requests')).toContainText('접수됨')
  await expectNoHorizontalScroll(owner.page)
  // 방 운영 영역·운영 API에 작성자 식별자 없음(멤버 목록은 원래 방장에게 보이는 별도 기능 — 어느 글의 작성자인지는 잇지 않음)
  const ownerView =
    (await owner.page.getByTestId('space-moderation').innerHTML()) +
    JSON.stringify(await owner.api.get(`/api/v1/community/spaces/${room.slug}/moderation`)) +
    JSON.stringify(await owner.api.get(`/api/v1/community/posts/${post.id}`))
  for (const v of [author.id, author.email, author.handle, author.displayName]) expect(ownerView).not.toContain(v)

  // ── 운영자: 사유를 기록하고 작성자 확인 → 이 방 7일 쓰기 제한 ──
  await operator.page.goto('/operator/community-moderation')
  // desktop·mobile이 같은 서버에서 동시에 돌므로 방 이름으로 이 요청만 고릅니다.
  const item = operator.page.getByTestId('op-sanction-requests').locator('li').filter({ hasText: roomName })
  await item.getByText('작성자 확인·이용 제한').click()
  await item.getByLabel('작성자 확인 사유(필수)').fill('방장 제재 요청 검토(E2E)')
  await item.getByRole('button', { name: '사유를 기록하고 작성자 확인' }).click()
  await expect(item.getByTestId('lookup-result')).toContainText(`@${author.handle}`)
  await item.getByLabel('내부 메모(필수, 운영자만)').fill('E2E: 반복 비방 1차')
  await item.getByLabel('당사자에게 보일 사유(필수)').fill('반복된 비방으로 이 방에서 7일간 쓰기가 제한됩니다.')
  await item.getByRole('button', { name: '이용 제한 발급' }).click()
  await expect(operator.page.getByRole('status').filter({ hasText: '이용 제한을 발급했습니다' }).first()).toBeVisible()
  await expectNoHorizontalScroll(operator.page)
  // 조회 기록: 사유는 보이고 작성자는 보이지 않음
  await operator.page.reload()
  const log = operator.page.getByTestId('op-lookup-log')
  await expect(log).toContainText('방장 제재 요청 검토(E2E)')
  await expect(log).not.toContainText(author.handle)

  // ── 작성자: 이 방에서는 못 쓰고(안내 + 403), 다른 방에서는 씀 ──
  await author.page.goto(`/community/b/${room.boards[0]!.id}`)
  await expect(author.page.getByTestId('write-restriction')).toContainText('이 공간에서')
  await expect(author.page.getByRole('button', { name: '글 올리기' })).toHaveCount(0)
  const denied = await author.api.raw('POST', `/api/v1/community/boards/${room.boards[0]!.id}/posts`, { title: '또', body: '막혀야 함' })
  expect(denied.status()).toBe(403)
  expect(JSON.stringify(await denied.json())).toContain('write_restricted')
  await author.page.goto(`/community/b/${other.boards[0]!.id}`)
  await expect(author.page.getByTestId('write-restriction')).toHaveCount(0)
  await author.page.getByLabel('제목').fill(`다른 방 글 ${rand(3)}`)
  await author.page.getByLabel('내용').fill('여기서는 씁니다')
  await author.page.getByRole('button', { name: '글 올리기' }).click()
  await author.page.waitForURL(/\/community\/p\/[0-9a-f-]{36}$/)
  await expect(author.page.getByText('여기서는 씁니다')).toBeVisible()
  // 본인 운영 안내: 수준·범위·사유, 이의제기 가능
  await author.page.goto('/me/moderation-notices')
  await expect(author.page.getByTestId('sanction-summary').first()).toContainText('쓰기 기간 제한')
  await expect(author.page.getByRole('button', { name: '이의제기' }).first()).toBeVisible()

  // ── 방장: 처리됨(제재가 내려짐) + 이 방 제한 1건, 누구인지는 없음 ──
  await owner.page.goto(`/community/s/${room.slug}`)
  await expect(owner.page.getByTestId('space-restrictions')).toContainText('1건')
  await expect(owner.page.getByTestId('sanction-requests')).toContainText('제재가 내려졌습니다')
  const after =
    (await owner.page.getByTestId('space-moderation').innerHTML()) +
    JSON.stringify(await owner.api.get(`/api/v1/community/spaces/${room.slug}/moderation`)) +
    JSON.stringify(await owner.api.get<BoardPostsDto>(`/api/v1/community/boards/${room.boards[0]!.id}/posts`))
  for (const v of [author.id, author.email, author.handle, author.displayName]) expect(after).not.toContain(v)
})
