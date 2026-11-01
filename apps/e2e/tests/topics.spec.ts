/**
 * A-05 토픽·소속 표시 익명(DELIVERY_PLAN §4.3 A-05, ADR 0042). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만 화면·API로 확인합니다:
 * 토픽 목록·운영자 토픽 만들기 API는 404, CLI와 같은 규칙으로 DB에 준비한 토픽도 상세·게시판·글쓰기가 404, `/community/topics` 화면은 "찾을 수 없음",
 * 커뮤니티 첫 화면에 토픽 링크가 없고, 공식 페이지에서 소속 표시 익명(affiliated_anonymous)을 고르면 422입니다.
 * 켜진 상태의 규칙(시나리오 Y 임계값·작성자에게만 넓힘 안내·작성 시점 고정·학과/기수 미표시·DB 불변식·S-02 투영 0건)은
 * web 통합 테스트(topics·identity-boundary)와 domain 단위 테스트가 덮습니다.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { e2eSql, grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'

test('A-05: P2 topics 플래그가 꺼져 있으면(기본) 토픽 API·화면은 404, 진입점이 없고 소속 표시 익명은 공식 페이지에서 422', async ({ newUser }) => {
  const operator = await newUser('topicOp')
  grantOperator(operator.email)
  const author = await newUser('topic')
  const school = await pastTerm(author.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(author.api, school.schoolId, domain, 't')

  expect((await author.api.raw('GET', '/api/v1/community/topics')).status()).toBe(404)
  expect((await operator.api.raw('POST', '/api/v1/operator/community/topics', { name: `취준 ${rand(3)}`, category: 'career' })).status()).toBe(404)

  // 운영자 CLI(`pnpm --filter @peerchive/db topic create`)는 플래그와 무관하게 준비할 수 있습니다. 같은 행을 DB로 만듭니다.
  const slug = rand(5)
  const [topic] = await e2eSql()<{ id: string }[]>`
    insert into community_spaces (kind, name, slug, current_name_mode, topic_category, capacity, created_by)
    values ('topic', ${`취준 ${rand(3)}`}, ${slug}, 'affiliated_anonymous', 'career', 100000, ${operator.id}) returning id`
  const [board] = await e2eSql()<{ id: string }[]>`
    insert into boards (space_id, kind, title, write_role, position) values (${topic!.id}, 'general', '게시판', 'member', 0) returning id`
  for (const who of [author, operator]) {
    expect((await who.api.raw('GET', `/api/v1/community/spaces/${slug}`)).status()).toBe(404)
    expect((await who.api.raw('GET', `/api/v1/community/boards/${board!.id}/posts`)).status()).toBe(404)
  }
  expect((await author.api.raw('POST', `/api/v1/community/boards/${board!.id}/posts`, { title: '취준', body: '면접', affiliationScope: 'institution' })).status()).toBe(404)

  // 공식 페이지: 소속 표시 익명·소속 표시 입력은 토픽 전용(422).
  const created = await operator.api.raw('POST', '/api/v1/operator/community/official-pages', { schoolId: school.schoolId })
  expect(created.status(), await created.text()).toBe(201)
  const page = (await created.json()) as { boards: Array<{ id: string; kind: string }> }
  const free = page.boards.find((b) => b.kind === 'free')!
  const affiliated = await author.api.raw('POST', `/api/v1/community/boards/${free.id}/posts`, { title: '소속', body: '표시', nameMode: 'affiliated_anonymous' })
  expect(affiliated.status()).toBe(422)
  expect(JSON.stringify(await affiliated.json())).toContain('affiliated_not_allowed')
  const scoped = await author.api.raw('POST', `/api/v1/community/boards/${free.id}/posts`, { title: '소속', body: '표시', affiliationScope: 'institution' })
  expect(scoped.status()).toBe(422)

  await author.page.goto('/community')
  await expect(author.page.getByRole('heading', { level: 1, name: '커뮤니티' })).toBeVisible()
  await expect(author.page.getByTestId('topics-link')).toHaveCount(0)
  const response = await author.page.goto('/community/topics')
  expect(response?.status()).toBe(404)
  await expect(author.page.getByRole('heading', { level: 1 })).toHaveText('페이지를 찾을 수 없습니다')
})
