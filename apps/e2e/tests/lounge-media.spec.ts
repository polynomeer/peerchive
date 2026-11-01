/**
 * A-04 공감 라운지 미디어·졸업생 열람(DELIVERY_PLAN §4.3 A-04, ADR 0041). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만 화면·API로 확인합니다:
 * 라운지(공식 학교 페이지 자유 게시판) 글의 미디어 API(붙이기·올리기·보기·지우기)는 404, 글 화면에 이미지 영역이 없고, 졸업생 인증 이력(인증 뒤 메일
 * 확인이 끝난 졸업생)만 있는 사람은 기존처럼 공식 페이지·졸업생 게시판이 404입니다(active 인증만 봄).
 * 켜진 상태의 규칙(검사·EXIF 제거·짧은 서명 URL·읽는 사람만·가린 글 404·한도·졸업생 열람·해제 이력 제외·경계)은
 * web 통합 테스트(lounge-media·identity-boundary)가 덮습니다.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { e2eSql, grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'

test('A-04: P2 alumni 플래그가 꺼져 있으면(기본) 라운지 미디어 API는 404, 글 화면에 이미지 영역이 없고 졸업생 인증 이력은 열람에 쓰이지 않음', async ({ newUser }) => {
  const operator = await newUser('loungeOp')
  grantOperator(operator.email)
  const author = await newUser('lounge')
  const school = await pastTerm(author.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(author.api, school.schoolId, domain, 'l')

  const created = await operator.api.raw('POST', '/api/v1/operator/community/official-pages', { schoolId: school.schoolId })
  expect(created.status(), await created.text()).toBe(201)
  const page = (await created.json()) as { slug: string; boards: Array<{ id: string; kind: string }> }
  const lounge = page.boards.find((b) => b.kind === 'free')!
  const alumniBoard = page.boards.find((b) => b.kind === 'alumni')!
  const posted = await author.api.raw('POST', `/api/v1/community/boards/${lounge.id}/posts`, { title: `학식 ${rand(3)}`, body: '사진 붙이려던 글' })
  expect(posted.status(), await posted.text()).toBe(201)
  const post = (await posted.json()) as { id: string; lounge?: unknown }
  expect(post.lounge).toBeUndefined()

  const fakeId = crypto.randomUUID()
  const base = `/api/v1/community/posts/${post.id}/media`
  for (const [method, path, body] of [
    ['POST', base, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }],
    ['PUT', `${base}/${fakeId}/content`, undefined],
    ['GET', `${base}/${fakeId}/file?exp=1&sig=${'0'.repeat(64)}`, undefined],
    ['DELETE', `${base}/${fakeId}`, undefined],
  ] as const) {
    expect((await author.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }

  await author.page.goto(`/community/p/${post.id}`)
  await expect(author.page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(author.page.getByTestId('lounge-media')).toHaveCount(0)

  // 재학 중 인증 → 졸업 → 학교 메일 확인이 끝난 졸업생(메일 해시 없음, 인증 시각 유지). 플래그가 꺼지면 기존처럼 404.
  const graduate = await newUser('loungeGrad')
  await e2eSql()`
    insert into institution_affiliations (user_id, school_id, email_domain, standing, status, verified_at)
    values (${graduate.id}, ${school.schoolId}, ${domain}, 'alumni', 'expired', now() - interval '3 years')`
  expect((await graduate.api.raw('GET', `/api/v1/community/spaces/${page.slug}`)).status()).toBe(404)
  expect((await graduate.api.raw('GET', `/api/v1/community/boards/${alumniBoard.id}/posts`)).status()).toBe(404)
  expect((await graduate.api.raw('GET', `/api/v1/community/posts/${post.id}`)).status()).toBe(404)
})
