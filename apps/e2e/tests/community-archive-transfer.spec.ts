/**
 * C-09 아카이브로 옮기기(DELIVERY_PLAN §4.1 C-09, PROOFU_EVOLUTION_PLAN §8.5·§8.9.8, ADR 0025). 빌드한 실제 서버로, 화면에서:
 * - 익명 방의 질문 게시판 글에 답이 달리고, 질문한 학생이 답을 채택 → "아카이브로 옮기기"로 과목 허브 막힘 Q&A 요청(과목 고르기·내 이름 익명)
 * - 질문한 학생 화면에는 "답변자 동의 대기 중"만(답한 학생의 이름·핸들 없음)
 * - 답한 학생은 커뮤니티 알림에서 요청을 열어 옮겨질 글을 보고 익명으로 동의 → 비로그인 방문자가 /c/<과목>에서 막힘 Q&A를 봄(익명 이름)
 * - 질문한 학생이 공개를 철회하면 과목 페이지에서 바로 사라짐. desktop·360px에서 가로 스크롤 없음.
 * 준비(학교 인증·방·질문 게시판·글·댓글)는 API로 합니다(글 화면은 community-posts.spec.ts가 확인).
 */
import type { CommunityPostDto, SpaceDetailDto } from '../../web/shared/types/api'
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

test('C-09: 질문 → 답 채택 → 막힘 Q&A로 옮기기 → 답한 학생이 알림에서 동의 → 과목 페이지(비로그인) → 철회하면 사라짐', async ({ newUser, anon }) => {
  test.setTimeout(180_000)
  const asker = await newUser('qaasker')
  const answerer = await newUser('qaanswer')
  const school = await pastTerm(asker.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(asker.api, school.schoolId, domain, 'q')
  await verifyByApi(answerer.api, school.schoolId, domain, 'a')
  const room = await asker.api.post<SpaceDetailDto>('/api/v1/community/spaces', {
    name: `E2E 질문방 ${rand(3)}`,
    nameMode: 'anonymous',
    joinPolicy: 'open',
    schoolId: school.schoolId,
  })
  const board = await asker.api.post<{ id: string }>(`/api/v1/community/spaces/${room.slug}/boards`, { kind: 'question', title: '질문' })
  await answerer.api.post(`/api/v1/community/spaces/${room.slug}/join`)
  const title = `fork 좀비 프로세스 ${rand(3)}`
  const post = await asker.api.post<CommunityPostDto>(`/api/v1/community/boards/${board.id}/posts`, { title, body: '자식 프로세스가 좀비로 남아요. 어디를 봐야 하나요?' })
  const answer = 'waitpid로 자식을 회수하는지 먼저 확인해 보세요.'
  await answerer.api.post(`/api/v1/community/posts/${post.id}/comments`, { body: answer })

  // ── 질문한 학생: 답 채택 → 아카이브로 옮기기(과목 Q&A) ──
  const page = asker.page
  await page.goto(`/community/p/${post.id}`)
  await page.getByRole('button', { name: '이 답변 채택' }).click()
  await expect(page.getByTestId('accepted-badge')).toHaveText('채택된 답변')
  await page.getByTestId('archive-open').click()
  const form = page.getByTestId('archive-form')
  await expect(form.getByLabel(/과목 허브 막힘 Q&A/)).toBeChecked()
  await form.getByTestId('archive-course-q').fill(school.courseTitle)
  await form.getByTestId('archive-course-search').click()
  await form.getByRole('button', { name: school.courseTitle }).click()
  await expect(form.getByTestId('archive-course-chosen')).toContainText(school.courseTitle)
  await expect(form.getByLabel('익명("질문한 학생")')).toBeChecked()
  await expectNoHorizontalScroll(page)
  await form.getByTestId('archive-submit').click()
  await page.waitForURL(/\/community\/archive-transfers\/[0-9a-f-]{36}$/)
  const transferId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByTestId('transfer-status')).toHaveText('동의 기다리는 중')
  await expect(page.getByTestId('counterpart-status')).toHaveText('답변자 동의 대기 중')
  await expect(page).toHaveTitle('Peerchive 커뮤니티')
  for (const v of [answerer.id, answerer.handle, answerer.displayName, answerer.email]) expect(await page.content()).not.toContain(v)
  const asJson = JSON.stringify(await asker.api.get(`/api/v1/community/archive-transfers/${transferId}`))
  for (const v of [answerer.id, answerer.handle, answerer.displayName, answerer.email]) expect(asJson).not.toContain(v)
  await expectNoHorizontalScroll(page)

  // 동의 전에는 과목 페이지에 없음
  const visitor = await anon()
  await visitor.page.goto(`/c/${school.courseId}`)
  await expect(visitor.page.getByTestId('hub-qa')).toContainText('아직 막힘 Q&A가 없습니다')

  // ── 답한 학생: 알림 → 요청 화면 → 옮겨질 글 확인 → 익명으로 동의 ──
  const ap = answerer.page
  await ap.goto('/community/notices')
  await ap.getByTestId('archive-notice-archive_consent_requested').click()
  await ap.waitForURL(new RegExp(`/community/archive-transfers/${transferId}$`))
  await expect(ap.getByTestId('transfer-preview')).toContainText(title)
  await expect(ap.getByTestId('transfer-preview')).toContainText(answer)
  await expect(ap.getByTestId('transfer-preview')).toContainText('질문한 학생 표시: 질문한 학생')
  await expect(ap.getByLabel('익명("답한 학생")')).toBeChecked()
  await expectNoHorizontalScroll(ap)
  await ap.getByTestId('consent-grant').click()
  await expect(ap.getByTestId('transfer-status')).toHaveText('옮김')
  await expect(ap.getByTestId('course-qa-status')).toContainText('공개 중')

  // ── 비로그인 방문자: 과목 페이지에 막힘 Q&A(복사한 글과 고른 이름만) ──
  await visitor.page.goto(`/c/${school.courseId}`)
  const qa = visitor.page.getByTestId('hub-qa')
  await expect(qa).toContainText(title)
  await expect(qa).toContainText(answer)
  await expect(qa).toContainText('질문한 학생')
  await expect(qa).toContainText('답한 학생')
  const html = await visitor.page.content()
  for (const v of [answerer.id, answerer.handle, asker.id, asker.handle, room.slug, post.id, transferId]) expect(html).not.toContain(v)
  await expectNoHorizontalScroll(visitor.page)

  // 원 글에는 "아카이브로 옮겨짐"만
  await page.goto(`/community/p/${post.id}`)
  await expect(page.getByTestId('archived-marker')).toHaveText('아카이브로 옮겨짐')

  // ── 질문한 학생이 철회 → 과목 페이지에서 바로 사라짐 ──
  await page.goto(`/community/archive-transfers/${transferId}`)
  page.once('dialog', (d) => void d.accept())
  await page.getByTestId('qa-withdraw').click()
  await expect(page.getByTestId('course-qa-status')).toContainText('철회됨')
  await visitor.page.reload()
  await expect(visitor.page.getByTestId('hub-qa')).not.toContainText(title)
  await expect(visitor.page.getByTestId('hub-qa')).toContainText('아직 막힘 Q&A가 없습니다')
})
