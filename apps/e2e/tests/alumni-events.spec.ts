/**
 * A-02 동문회·OB 방의 일정·참석·공지 읽음·투표·앨범(DELIVERY_PLAN §4.3·§5.3 W, ADR 0039). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만
 * 화면·API로 확인합니다: 새 API 15개는 모두 404, 일반 방에는 공지 게시판·모임 링크가 없고 모임 화면은 "찾을 수 없습니다", 글에 읽음 수가 없음.
 * 켜진 상태의 규칙(회차별 응답 유일·응답자는 멤버만·읽음 수만·투표 집계만·앨범 검사와 서명 URL·나가기 삭제·경계)은 web 통합 테스트
 * (alumni-events·identity-boundary)와 worker 테스트(ops-purge·ops-cleanup)가 덮습니다.
 */
import { pastTerm, rand } from '../support/api'
import { schoolMailbox, verifyByApi } from '../support/affiliation'
import { expect, test } from '../support/fixtures'

test('A-02: P2 alumni 플래그가 꺼져 있으면(기본) 일정·투표·앨범·공지 읽음 API가 404이고 모임 화면도 없다', async ({ newUser }) => {
  const owner = await newUser('gatheroff')
  const school = await pastTerm(owner.api)
  const { domain } = schoolMailbox(school.schoolId)
  await verifyByApi(owner.api, school.schoolId, domain, 'a')

  const created = await owner.api.raw('POST', '/api/v1/community/spaces', { name: `모임 방 ${rand(3)}`, nameMode: 'anonymous', joinPolicy: 'open' })
  expect(created.status()).toBe(201)
  const room = (await created.json()) as { slug: string; template: string; boards: Array<{ id: string; kind: string }> }
  expect(room.template).toBe('general')
  expect(room.boards.map((b) => b.kind)).toEqual(['general'])
  const postRes = await owner.api.raw('POST', `/api/v1/community/boards/${room.boards[0]!.id}/posts`, { title: '안내', body: '본문' })
  expect(postRes.status()).toBe(201)
  const post = (await postRes.json()) as { id: string; noticeReads?: unknown }
  expect(post.noticeReads).toBeUndefined()

  const id = () => crypto.randomUUID()
  const base = `/api/v1/community/spaces/${room.slug}`
  for (const [method, path, body] of [
    ['GET', `${base}/events`, undefined],
    ['POST', `${base}/events`, { title: '홈커밍', startsAt: '2027-01-10T19:00:00+09:00' }],
    ['PATCH', `${base}/events/${id()}`, { title: 'x' }],
    ['POST', `${base}/events/${id()}/cancel`, undefined],
    ['PUT', `${base}/events/${id()}/rsvp`, { date: '2027-01-10', response: 'going' }],
    ['GET', `${base}/events/${id()}/rsvps?date=2027-01-10`, undefined],
    ['GET', `${base}/polls`, undefined],
    ['POST', `${base}/polls`, { question: '장소', options: ['a', 'b'], closesAt: '2027-01-10T19:00:00+09:00' }],
    ['POST', `${base}/polls/${id()}/votes`, { optionIndex: 0 }],
    ['POST', `${base}/polls/${id()}/close`, undefined],
    ['GET', `${base}/album`, undefined],
    ['POST', `${base}/album/photos`, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }],
    ['GET', `${base}/album/photos/${id()}/file?exp=1&sig=${'0'.repeat(64)}`, undefined],
    ['DELETE', `${base}/album/photos/${id()}`, undefined],
    ['POST', `/api/v1/community/posts/${post.id}/read`, undefined],
  ] as const) {
    expect((await owner.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }

  const page = owner.page
  await page.goto(`/community/s/${room.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByTestId('gatherings-link')).toHaveCount(0)
  await page.goto(`/community/p/${post.id}`)
  await expect(page.getByRole('heading', { level: 1, name: '안내' })).toBeVisible()
  await expect(page.getByTestId('notice-reads')).toHaveCount(0)
  await page.goto(`/community/gatherings/${room.slug}`)
  await expect(page.getByRole('heading', { level: 1, name: '찾을 수 없습니다' })).toBeVisible()
})
