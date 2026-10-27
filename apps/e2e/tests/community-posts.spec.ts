/**
 * C-04 커뮤니티 글·댓글·공감·스레드 익명 번호(DELIVERY_PLAN §4.1 C-04·§5.1 K, ADR 0022). 빌드한 실제 서버로, 화면에서:
 * - 익명 방에서 두 멤버가 한 스레드로 대화: 글쓴이는 `글쓴이`, 다른 사람은 `익명1`(같은 사람은 같은 번호), 글쓰기 화면에 "이 방은 익명으로 표시됩니다".
 * - 두 번째 스레드는 번호가 따로 매겨짐(첫 스레드의 `글쓴이`가 둘째 스레드에서는 `익명1`).
 * - 방장(운영진) 화면도 같은 표시이고, API JSON에 사람 id·이메일·핸들이 없음. 공감(비추천 없음)·신고 대화상자.
 * - 표시명 방(ADR 0030): 표시명 프로필이 없으면 글쓰기 화면이 /settings/personas로 안내하고 API는 403 `display_persona_required`,
 *   만든 뒤에는 글이 그 표시명으로 보이고 화면·JSON에 계정 이름·실명 핸들·표시명 핸들이 없음.
 * - 360px(mobile project)에서 가로 스크롤 없음. 문서 제목은 고정(C-05).
 * 준비(학교 인증·방 만들기·가입)는 API로 합니다(그 화면은 community.spec.ts·affiliation.spec.ts가 확인).
 */
import type { Page } from '@playwright/test'
import type { CommunityPostDto, SpaceDetailDto } from '../../web/shared/types/api'
import { createDisplayPersona, pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

const commentAuthors = (page: Page) => page.getByTestId('comments').locator('.comment-author')

async function writePost(page: Page, slug: string, title: string, body: string): Promise<string> {
  await page.goto(`/community/s/${slug}`)
  await page.getByRole('link', { name: '게시판', exact: true }).click()
  await page.waitForURL(/\/community\/b\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('name-mode-note')).toHaveText('이 방은 익명으로 표시됩니다.')
  await expect(page.getByText('방장·모더레이터는 작성자를 볼 수 없고')).toBeVisible()
  await page.getByLabel('제목').fill(title)
  await page.getByLabel('내용').fill(body)
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: '글 올리기' }).click()
  await page.waitForURL(/\/community\/p\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  return new URL(page.url()).pathname.split('/').pop()!
}

async function comment(page: Page, text: string): Promise<void> {
  await page.getByLabel('댓글', { exact: true }).fill(text)
  await page.getByRole('button', { name: '댓글 달기' }).click()
  await expect(page.getByRole('status').filter({ hasText: '댓글을 달았습니다' })).toBeVisible()
  await expect(page.getByTestId('comments')).toContainText(text)
}

test('C-04: 익명 방 스레드 대화(글쓴이·익명1), 둘째 스레드는 따로 번호, 방장 화면도 같은 표시', async ({ newUser }) => {
  // 사용자 넷의 실제 로그인 + 두 스레드라 기본 90초보다 오래 걸릴 수 있습니다.
  test.setTimeout(180_000)
  const owner = await newUser('postowner')
  const alice = await newUser('postalice')
  const bob = await newUser('postbob')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(owner.api, school.schoolId, domain, 'o')
  await verifyByApi(alice.api, school.schoolId, domain, 'a')
  await verifyByApi(bob.api, school.schoolId, domain, 'b')
  const room = await owner.api.post<SpaceDetailDto>('/api/v1/community/spaces', { name: `E2E 익명방 ${rand(3)}`, nameMode: 'anonymous', joinPolicy: 'open' })
  await alice.api.post(`/api/v1/community/spaces/${room.slug}/join`)
  await bob.api.post(`/api/v1/community/spaces/${room.slug}/join`)

  // ── 첫 스레드: 앨리스가 글, 밥이 댓글, 앨리스가 답 ──
  const title1 = `질문 ${rand(3)}`
  const post1 = await writePost(alice.page, room.slug, title1, '자료구조 과제 범위가 어디까지인가요?')
  await expect(alice.page.locator('.post-author')).toHaveText('글쓴이')
  await expect(alice.page.getByText('내 글', { exact: true })).toBeVisible()
  await expect(alice.page).toHaveTitle('Peerchive 커뮤니티')

  await bob.page.goto(`/community/p/${post1}`)
  await expect(bob.page.locator('.post-author')).toHaveText('글쓴이')
  await expect(bob.page.getByText('내 글', { exact: true })).toHaveCount(0)
  await expect(bob.page.getByTestId('comment-name-mode-note')).toHaveText('이 방은 익명으로 표시됩니다.')
  await comment(bob.page, '3장까지라고 들었어요')
  await expect(commentAuthors(bob.page)).toHaveText(['익명1'])
  await expect(bob.page.getByText('내 댓글', { exact: true })).toBeVisible()
  // 공감(비추천 버튼은 없음)
  const like = bob.page.getByRole('button', { name: /^공감 0개/ })
  await like.click()
  await expect(bob.page.getByRole('button', { name: '공감 1개, 공감함' })).toHaveAttribute('aria-pressed', 'true')
  await expect(bob.page.getByRole('button', { name: /비추천|싫어요/ })).toHaveCount(0)

  await alice.page.reload()
  await comment(alice.page, '감사합니다!')
  await expect(commentAuthors(alice.page)).toHaveText(['익명1', '글쓴이'])
  await bob.page.reload()
  await comment(bob.page, '시험 범위도 같아요')
  await expect(commentAuthors(bob.page)).toHaveText(['익명1', '글쓴이', '익명1'])
  await expectNoHorizontalScroll(bob.page)

  // ── 둘째 스레드: 밥이 글, 앨리스·방장이 댓글 → 이 스레드만의 번호 ──
  const post2 = await writePost(bob.page, room.slug, `둘째 ${rand(3)}`, '스터디 하실 분')
  await alice.page.goto(`/community/p/${post2}`)
  await comment(alice.page, '저요')
  await owner.page.goto(`/community/p/${post2}`)
  await comment(owner.page, '저도요')
  await expect(commentAuthors(owner.page)).toHaveText(['익명1', '익명2'])
  await expect(owner.page.locator('.post-author')).toHaveText('글쓴이')

  // ── 방장(운영진) 화면: 첫 스레드도 같은 표시, 내 글 표시 없음, 신고 가능 ──
  await owner.page.goto(`/community/p/${post1}`)
  await expect(owner.page.locator('.post-author')).toHaveText('글쓴이')
  await expect(commentAuthors(owner.page)).toHaveText(['익명1', '글쓴이', '익명1'])
  await expect(owner.page.getByText('내 글', { exact: true })).toHaveCount(0)
  await expect(owner.page.getByText('공감 1', { exact: false }).first()).toBeVisible()
  await expectNoHorizontalScroll(owner.page)
  await owner.page.locator('article').getByRole('button', { name: '신고하기' }).click()
  const dialog = owner.page.getByRole('dialog', { name: '신고하기' })
  await dialog.getByLabel('스팸·홍보').check()
  await dialog.getByRole('button', { name: '신고 보내기' }).click()
  await expect(dialog.getByRole('status')).toContainText('신고가 접수되었습니다')
  await dialog.getByRole('button', { name: '닫기' }).click()

  // API: 방장 응답과 다른 멤버 응답의 작성자 표시가 같고, 사람 id·이메일·핸들이 없음
  const asOwner = await owner.api.get<CommunityPostDto>(`/api/v1/community/posts/${post1}`)
  const asBob = await bob.api.get<CommunityPostDto>(`/api/v1/community/posts/${post1}`)
  const labels = (p: CommunityPostDto) => [p.author.label, ...p.comments.flatMap((c) => [c.author.label, ...c.replies.map((r) => r.author.label)])]
  expect(labels(asOwner)).toEqual(['글쓴이', '익명1', '글쓴이', '익명1'])
  expect(labels(asBob)).toEqual(labels(asOwner))
  const json = JSON.stringify([asOwner, await owner.api.get(`/api/v1/community/posts/${post2}`), await owner.api.get(`/api/v1/community/boards/${asOwner.board.id}/posts`)])
  for (const u of [alice, bob]) {
    expect(json).not.toContain(u.id)
    expect(json).not.toContain(u.email)
    expect(json).not.toContain(u.handle)
    expect(json).not.toContain(u.displayName)
  }
  const res = await owner.api.raw('GET', `/api/v1/community/posts/${post1}`)
  expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow, noarchive')
  // 다른 학교·비멤버는 글도 404
  const outsider = await newUser('postoutsider')
  expect((await outsider.api.raw('GET', `/api/v1/community/posts/${post1}`)).status()).toBe(404)
  await outsider.page.goto(`/community/p/${post1}`)
  await expect(outsider.page.getByRole('heading', { level: 1, name: '글을 찾을 수 없습니다' })).toBeVisible()
  expect(await outsider.page.content()).not.toContain(title1)
})

test('ADR 0030: 표시명 방은 표시명 프로필로만 쓰고, 계정 이름·핸들 없이 그 표시명으로 보인다', async ({ newUser }) => {
  test.setTimeout(150_000)
  const owner = await newUser('dispowner')
  const writer = await newUser('dispwriter')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(owner.api, school.schoolId, domain, 'o')
  await verifyByApi(writer.api, school.schoolId, domain, 'w')
  await createDisplayPersona(owner.api, 'dispowner')
  const room = await owner.api.post<SpaceDetailDto>('/api/v1/community/spaces', { name: `E2E 표시명방 ${rand(3)}`, nameMode: 'display', joinPolicy: 'open' })
  await writer.api.post(`/api/v1/community/spaces/${room.slug}/join`)
  const boardId = room.boards[0]!.id

  // 표시명 프로필 없음: 글쓰기 화면이 만들라고 안내(링크), API는 403 + requirement
  const page = writer.page
  await page.goto(`/community/b/${boardId}`)
  await expect(page.getByTestId('name-mode-note')).toHaveText('이 방은 표시명으로 표시됩니다.')
  const prompt = page.getByTestId('display-persona-required')
  await expect(prompt).toBeVisible()
  await expect(prompt.getByRole('link', { name: '표시명 프로필' })).toHaveAttribute('href', '/settings/personas')
  const denied = await writer.api.raw('POST', `/api/v1/community/boards/${boardId}/posts`, { title: '막힘', body: '막혀야 함' })
  expect(denied.status()).toBe(403)
  expect(await denied.json()).toMatchObject({ data: { code: 'display_persona_required', requirement: 'display_persona' } })
  await expectNoHorizontalScroll(page)

  // 표시명 프로필을 만든 뒤: 안내가 사라지고, 글이 그 표시명으로 보임
  const persona = await createDisplayPersona(writer.api, 'dispwriter')
  const title = `표시명 글 ${rand(3)}`
  await page.goto(`/community/b/${boardId}`)
  await expect(page.getByTestId('display-persona-required')).toHaveCount(0)
  await page.getByLabel('제목').fill(title)
  await page.getByLabel('내용').fill('표시명으로 쓰는 글')
  await page.getByRole('button', { name: '글 올리기' }).click()
  await page.waitForURL(/\/community\/p\/[0-9a-f-]{36}$/)
  await expect(page.locator('.post-author')).toHaveText(persona.displayName)
  const postId = new URL(page.url()).pathname.split('/').pop()!

  // 방장 화면·JSON: 표시명만, 계정 이름·실명 핸들·표시명 핸들·사람 id 없음
  await owner.page.goto(`/community/p/${postId}`)
  await expect(owner.page.locator('.post-author')).toHaveText(persona.displayName)
  const html = await owner.page.content()
  const json = JSON.stringify([await owner.api.get(`/api/v1/community/posts/${postId}`), await owner.api.get(`/api/v1/community/boards/${boardId}/posts`)])
  for (const text of [html, json]) {
    for (const secret of [writer.displayName, writer.handle, persona.handle, writer.id, writer.email]) expect(text).not.toContain(secret)
  }
  expect(json).toContain(persona.displayName)
})
