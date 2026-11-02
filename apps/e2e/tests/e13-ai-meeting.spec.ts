/**
 * E-13 AI 회의 요약(DELIVERY_PLAN §4.4 E-13, ADR 0058). E2E 서버에는 AI 공급자(PEERCHIVE_AI_ENABLED·ANTHROPIC_API_KEY)와 내부 API 비밀이 없으므로
 * 꺼진 상태만 확인합니다(네트워크 없음): features.ai false, 새 웹 경로 모두 404, 과제 화면에 회의 요약 칸이 없음.
 * 켜진 상태(동의·철회·새 멤버, 요약 전 거절, 원문 미저장, 승인·할 일·거절, 보존)는 web 통합 테스트(ai-meeting)와 봇 테스트(summarize)가 덮습니다.
 */
import type { FeatureFlagsDto } from '../../web/shared/types/api'
import { createProject, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('E-13: AI 공급자가 없으면(기본) 회의 요약 칸이 없고 새 API는 404', async ({ newUser }) => {
  const owner = await newUser('meet')
  const project = await createProject(owner.api, { title: `회의 요약 없는 과제 ${rand()}`, kind: 'team' })

  expect((await owner.api.get<FeatureFlagsDto>('/api/v1/features')).ai).toBe(false)
  const base = `/api/v1/projects/${project.id}/ai-meetings`
  const id = crypto.randomUUID()
  for (const [method, path, body] of [
    ['GET', base, undefined],
    ['PUT', `${base}/channels/${id}`, { enabled: true }],
    ['PUT', `${base}/channels/${id}/consent`, { agree: true }],
    ['POST', `${base}/drafts/${id}/approve`, {}],
    ['DELETE', `${base}/drafts/${id}`, undefined],
  ] as const) {
    expect((await owner.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }

  await owner.page.goto(`/projects/${project.id}`)
  await expect(owner.page.getByRole('heading', { level: 2, name: '디스코드 연결' })).toBeVisible()
  await expect(owner.page.getByTestId('ai-meeting-section')).toHaveCount(0)
})
