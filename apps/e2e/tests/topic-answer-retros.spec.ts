/**
 * A-06 현직자 답변 이동·수료 회고(DELIVERY_PLAN §4.3 A-06, ADR 0043). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태와 플래그와 무관한
 * 규칙만 화면·API로 확인합니다: 수료 회고 API(목록·쓰기 화면·쓰기·내 회고)와 `/community/retros` 화면은 404, 커뮤니티 첫 화면에 회고 링크가 없고,
 * DB에 준비한 토픽의 답변을 옮기는 요청도 404, 토픽이 아닌 공식 페이지의 댓글을 선배 노트로 옮기면 422 `commentId: not_allowed`, 선배 노트를
 * 직접 만들 때 "소속 표시 유지"(affiliation)는 422입니다.
 * 켜진 상태(이름 표시 네 가지·고정된 소속 표시 복사·투영 0건·회고 임계값·평가 필드 없음·신고·탈퇴 정리·S-02 확장)는 web 통합 테스트
 * (topic-answer-retros·identity-boundary)가 덮습니다.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { e2eSql, grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'

test('A-06: 플래그가 꺼져 있으면(기본) 수료 회고 API·화면 404·진입점 없음, 토픽 답변 옮기기 404, 토픽 밖 댓글·직접 만든 노트의 소속 표시는 422', async ({ newUser }) => {
  const operator = await newUser('retroOp')
  grantOperator(operator.email)
  const senior = await newUser('retro')
  const school = await pastTerm(senior.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(senior.api, school.schoolId, domain, 'r')

  for (const path of ['/api/v1/completion-retros', '/api/v1/me/completion-retros', '/api/v1/me/completion-retros/composer']) {
    expect((await senior.api.raw('GET', path)).status(), path).toBe(404)
  }
  const write = await senior.api.raw('POST', '/api/v1/me/completion-retros', {
    affiliationId: crypto.randomUUID(),
    displayMode: 'anonymous',
    answers: { learned: '배운 것', curriculum: '과정' },
    guidelinesConfirmed: true,
  })
  expect(write.status()).toBe(404)

  // 운영자 CLI와 같은 규칙으로 준비한 토픽: 플래그가 꺼져 있으면 답변을 옮기는 요청·선택지도 404.
  const slug = rand(5)
  const [topic] = await e2eSql()<{ id: string }[]>`
    insert into community_spaces (kind, name, slug, current_name_mode, topic_category, capacity, created_by)
    values ('topic', ${`직무 ${rand(3)}`}, ${slug}, 'affiliated_anonymous', 'role', 100000, ${operator.id}) returning id`
  const [board] = await e2eSql()<{ id: string }[]>`
    insert into boards (space_id, kind, title, write_role, position) values (${topic!.id}, 'general', '게시판', 'member', 0) returning id`
  const [post] = await e2eSql()<{ id: string }[]>`
    insert into community_posts (board_id, space_id, author_id, name_mode, label_scope_requested, label_scope_applied, title, body)
    values (${board!.id}, ${topic!.id}, ${operator.id}, 'affiliated_anonymous', 'none', 'none', '질문', '무엇부터?') returning id`
  const [comment] = await e2eSql()<{ id: string }[]>`
    insert into community_comments (post_id, author_id, name_mode, label_scope_requested, label_scope_applied, body)
    values (${post!.id}, ${senior.id}, 'affiliated_anonymous', 'none', 'none', '로그부터 읽으세요') returning id`
  const move = { target: 'senior_note', courseId: school.courseId, commentId: comment!.id, answerKey: 'wishKnew', displayMode: 'anonymous', noAnswersConfirmed: true }
  expect((await senior.api.raw('POST', `/api/v1/community/posts/${post!.id}/archive-transfers`, move)).status()).toBe(404)
  expect((await senior.api.raw('GET', `/api/v1/community/posts/${post!.id}/archive-options?commentId=${comment!.id}`)).status()).toBe(404)

  // 토픽이 아닌 공식 페이지의 댓글은 이 경로가 없습니다(플래그와 무관).
  const created = await operator.api.raw('POST', '/api/v1/operator/community/official-pages', { schoolId: school.schoolId })
  expect(created.status(), await created.text()).toBe(201)
  const page = (await created.json()) as { boards: Array<{ id: string; kind: string }> }
  const free = page.boards.find((b) => b.kind === 'free')!
  const officialPost = await senior.api.post<{ id: string }>(`/api/v1/community/boards/${free.id}/posts`, { title: '조언', body: '공식 페이지 글' })
  const thread = await senior.api.post<{ comments: Array<{ id: string }> }>(`/api/v1/community/posts/${officialPost.id}/comments`, { body: '공식 댓글' })
  const offTopic = await senior.api.raw('POST', `/api/v1/community/posts/${officialPost.id}/archive-transfers`, { ...move, commentId: thread.comments[0]!.id })
  expect(offTopic.status()).toBe(422)
  expect(JSON.stringify(await offTopic.json())).toContain('not_allowed')

  // 소속 표시 유지는 토픽 답변을 옮길 때만(직접 만들기는 422).
  const direct = await senior.api.raw('POST', `/api/v1/courses/${school.courseId}/senior-notes`, {
    displayMode: 'affiliation',
    answers: { firstWeek: '첫 주', timeSink: '시간' },
    noAnswersConfirmed: true,
  })
  expect(direct.status()).toBe(422)

  await senior.page.goto('/community')
  await expect(senior.page.getByRole('heading', { level: 1, name: '커뮤니티' })).toBeVisible()
  await expect(senior.page.getByTestId('retros-link')).toHaveCount(0)
  const response = await senior.page.goto('/community/retros')
  expect(response?.status()).toBe(404)
  await expect(senior.page.getByRole('heading', { level: 1 })).toHaveText('페이지를 찾을 수 없습니다')
})
