/**
 * E-12 AI 회고 인터뷰(DELIVERY_PLAN §4.4 E-12, ADR 0057). E2E 서버에는 AI 공급자(PEERCHIVE_AI_ENABLED·ANTHROPIC_API_KEY)가 없으므로
 * 꺼진 상태만 확인합니다(네트워크 없음): features.ai false, 새 경로 모두 404, 과제 화면에 AI 회고 칸이 없고 폼 체크인은 그대로 동작.
 * 켜진 상태(켜기·질문 흐름·초안·승인·버리기·한도·보낸 데이터 범위·보존)는 web 통합 테스트(ai-retro)와 @peerchive/ai 단위 테스트가 덮습니다.
 */
import type { FeatureFlagsDto, MyCheckinDto } from '../../web/shared/types/api'
import { createProject, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('E-12: AI 공급자가 없으면(기본) AI 회고 칸이 없고 새 API는 404, 폼 체크인은 그대로', async ({ newUser }) => {
  const owner = await newUser('ai')
  const project = await createProject(owner.api, { title: `AI 없는 과제 ${rand()}` })

  expect((await owner.api.get<FeatureFlagsDto>('/api/v1/features')).ai).toBe(false)
  const base = `/api/v1/projects/${project.id}/ai-retro`
  const draftId = crypto.randomUUID()
  for (const [method, path, body] of [
    ['GET', base, undefined],
    ['PUT', `${base}/opt-in`, { enabled: true }],
    ['POST', `${base}/session`, {}],
    ['DELETE', `${base}/session`, undefined],
    ['POST', `${base}/answers`, { questionNo: 1, answer: '답' }],
    ['POST', `${base}/drafts/${draftId}/approve`, {}],
    ['DELETE', `${base}/drafts/${draftId}`, undefined],
  ] as const) {
    expect((await owner.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }

  await owner.page.goto(`/projects/${project.id}`)
  await expect(owner.page.getByRole('heading', { level: 2, name: '주간 체크인' })).toBeVisible()
  await expect(owner.page.getByTestId('ai-retro-section')).toHaveCount(0)

  // 폼 체크인은 AI와 무관하게 그대로: 화면에서 내고, 한 줄을 막힘 로그로 옮깁니다.
  const note = `CORS 오류로 막힘 ${rand()}`
  const checkin = owner.page.locator('#checkin')
  // 체크인 칸이 내 체크인·팀 현황을 불러온 뒤(폼을 다시 채우기 전) 입력합니다.
  await expect(checkin.getByText('아직 안 냄')).toBeVisible()
  await checkin.getByRole('radio', { name: '~5시간' }).check()
  await checkin.getByRole('radio', { name: '3 보통' }).check()
  await checkin.getByLabel('3. 이번 주 가장 중요한 진전 또는 막힘 한 줄 (선택)').fill(note)
  await checkin.getByRole('checkbox', { name: '빌드 로그로 옮기기' }).check()
  await checkin.getByRole('radio', { name: '🧱 막힘' }).check()
  await checkin.getByRole('button', { name: '체크인 내기' }).click()
  await expect(checkin.getByText('체크인을 저장하고 한 줄을 빌드 로그로 옮겼습니다.')).toBeVisible()
  const saved = await owner.api.get<MyCheckinDto>(`/api/v1/projects/${project.id}/checkins/me`)
  expect(saved.checkin).toMatchObject({ timeBucket: 'lt5h', difficulty: 3, note })
  expect(saved.checkin!.promotedLogId).toBeTruthy()
})
