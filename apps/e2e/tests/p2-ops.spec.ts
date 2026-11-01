/**
 * A-07 운영·계측(DELIVERY_PLAN §4.3 A-07·§6.2 P2, ADR 0045). E2E 서버는 P2 플래그가 꺼진 기본 설정으로 뜨므로 꺼진 상태만 화면·API로 확인합니다:
 * 인증 수단별 처리 큐 API·화면 404, 운영자 첫 화면에 진입점 없음, P2 지표는 모든 칸 null이고 지표 화면에 P2 칸이 없음, 방 항목 신고 404.
 * 켜진 상태(종류별 신고·숨김·이의제기, 처리 큐·처리 시간 가림, 이벤트 키·시각, 지표 가림)는 web 통합 테스트(p2-ops)가 덮습니다.
 */
import { grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'

test('A-07: 플래그가 꺼져 있으면(기본) 처리 큐 404·진입점 없음, P2 지표 칸 없음, 방 항목 신고 404', async ({ newUser }) => {
  const operator = await newUser('p2Op')
  grantOperator(operator.email)
  const member = await newUser('p2Member')

  expect((await operator.api.raw('GET', '/api/v1/operator/institutions/verification-queue')).status()).toBe(404)
  const metrics = await operator.api.raw('GET', '/api/v1/operator/metrics/community/p2')
  expect(metrics.status()).toBe(200)
  expect(await metrics.json()).toMatchObject({ flags: { alumni: false, topics: false, institutions: false }, alumni: null, topics: null, institutions: null })
  expect((await member.api.raw('GET', '/api/v1/operator/metrics/community/p2')).status()).toBe(403)
  const report = await member.api.raw('POST', '/api/v1/reports', {
    targetType: 'room_item',
    targetRef: { spaceSlug: 'zzzzzzzzzz', kind: 'event', itemId: crypto.randomUUID() },
    reason: 'spam',
  })
  expect(report.status()).toBe(404)

  await operator.page.goto('/operator/verification-queue')
  await expect(operator.page.getByRole('heading', { name: '페이지를 찾을 수 없습니다' })).toBeVisible()
  await operator.page.goto('/operator')
  await expect(operator.page.getByRole('link', { name: '인증 처리 큐' })).toHaveCount(0)
  await operator.page.goto('/operator/metrics')
  await expect(operator.page.getByRole('heading', { name: 'pilot 지표', level: 1 })).toBeVisible()
  await expect(operator.page.getByRole('heading', { name: '졸업생·토픽·기관(§6.2 P2)' })).toHaveCount(0)
})
