/**
 * E-04 막힘 Q&A 스레드(DELIVERY_PLAN §4.4 E-04, ADR 0049). E2E 서버는 플래그(`PEERCHIVE_FEATURE_STUCK_QA`)가 꺼진 기본 설정으로 뜨므로 꺼진 상태만
 * 화면·API로 확인합니다: 기능 플래그는 꺼짐, 막힘 기록이 있는 공개 사례에도 "막힘 Q&A" 링크가 없고, 스레드 화면·API·신고는 404.
 * 켜진 상태의 규칙(질문 허용 게이트·익명 번호·도움됐어요 정렬·후배 기여·철회 시 닫힘·신고·숨김·작성자 확인)은 web 통합 테스트(stuck-qa)가 덮습니다.
 */
import type { FeatureFlagsDto, PublicPublicationDto } from '../../web/shared/types/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('E-04: 막힘 Q&A 플래그가 꺼져 있으면(기본) 사례 페이지에 링크가 없고 스레드 화면·API·신고는 404', async ({ newUser, anon }) => {
  const senior = await newUser('sqa')
  const pub = await publishCase(senior, { stuck: true })
  const visitor = await anon()
  const publicCase = await visitor.api.get<PublicPublicationDto>(`/api/v1/public/publications/${pub.slug}`)
  const key = publicCase.snapshot.logs.find((l) => l.tag === 'stuck')!.key

  expect((await senior.api.get<FeatureFlagsDto>('/api/v1/features')).stuckQa).toBe(false)

  await visitor.page.goto(`/p/${pub.slug}`)
  await expect(visitor.page.getByRole('heading', { level: 1, name: pub.title })).toBeVisible()
  await expect(visitor.page.getByTestId('case-stuck-qa')).toHaveCount(0)

  const card = `/api/v1/stuck-qa/cards/${pub.slug}/${encodeURIComponent(key)}`
  for (const [method, path, body] of [
    ['GET', card, undefined],
    ['PUT', card, { questionsAllowed: true }],
    ['POST', `${card}/threads`, { body: '왜 CORS 에러가 나나요?' }],
    ['GET', `/api/v1/stuck-qa/threads/${crypto.randomUUID()}`, undefined],
  ] as const) {
    expect((await senior.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }
  expect((await senior.api.raw('POST', '/api/v1/reports', { targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: crypto.randomUUID() }, reason: 'spam' })).status()).toBe(404)

  const res = await visitor.page.goto(`/stuck-qa/cards/${pub.slug}/${encodeURIComponent(key)}`)
  expect(res?.status()).toBe(404)
  await expect(visitor.page.getByRole('heading', { name: '막힘 Q&A를 찾을 수 없습니다' })).toBeVisible()
})
