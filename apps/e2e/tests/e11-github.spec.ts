/**
 * E-11 GitHub App 연동(DELIVERY_PLAN §4.4 E-11, ADR 0056). E2E 서버에는 GitHub App 설정(GITHUB_APP_*)이 없으므로 꺼진 상태만 확인합니다:
 * features.github false, 새 경로(계정 연결·과제 연결·후보·setup·OAuth 콜백·웹훅) 모두 404, 프로필 설정·과제 화면에 GitHub 칸이 없음,
 * 역할 선언은 그대로 동작. 켜진 상태(state·설치 확인·웹훅 서명·재전송·수집·해제·근거·공개 점검)는 web 통합·단위 테스트(github*)가 덮습니다.
 */
import type { FeatureFlagsDto } from '../../web/shared/types/api'
import { addClaim, createProject, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('E-11: GitHub App 설정이 없으면(기본) 연결 칸이 없고 새 API·웹훅은 404, 역할 선언은 그대로', async ({ newUser, anon }) => {
  const owner = await newUser('gh')
  const project = await createProject(owner.api, { title: `GitHub 없는 과제 ${rand()}` })

  expect((await owner.api.get<FeatureFlagsDto>('/api/v1/features')).github).toBe(false)
  for (const [method, path, body] of [
    ['GET', '/api/v1/me/integrations/github', undefined],
    ['POST', '/api/v1/me/integrations/github/link', {}],
    ['DELETE', '/api/v1/me/integrations/github', undefined],
    ['GET', `/api/v1/projects/${project.id}/github`, undefined],
    ['POST', `/api/v1/projects/${project.id}/github/install`, {}],
    ['POST', `/api/v1/projects/${project.id}/github/link`, { repoId: 1 }],
    ['GET', `/api/v1/projects/${project.id}/github/items`, undefined],
    ['DELETE', `/api/v1/projects/${project.id}/github`, undefined],
    ['GET', '/api/v1/github/setup?installation_id=1&state=x', undefined],
    ['GET', '/api/v1/github/oauth/callback?code=x&state=y', undefined],
  ] as const) {
    expect((await owner.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }
  const visitor = await anon()
  const webhook = await visitor.api.raw('POST', '/api/github/webhook', { zen: 'hi' }, { 'x-github-event': 'ping', 'x-github-delivery': crypto.randomUUID() })
  expect(webhook.status()).toBe(404)

  await owner.page.goto(`/projects/${project.id}`)
  await expect(owner.page.getByRole('heading', { level: 2, name: '디스코드 연결' })).toBeVisible()
  await expect(owner.page.getByTestId('github-section')).toHaveCount(0)
  await owner.page.goto('/onboarding')
  await expect(owner.page.getByTestId('github-link-section')).toHaveCount(0)

  // GitHub 없이도 역할 선언은 그대로(근거 종류 github는 후보가 없으면 422).
  const claim = await addClaim(owner.api, project.id, '로그인 API 담당')
  expect(claim.evidence).toEqual([])
  const bad = await owner.api.raw('POST', `/api/v1/projects/${project.id}/claims`, { text: 'x', evidence: [{ kind: 'github', id: crypto.randomUUID() }] })
  expect(bad.status()).toBe(422)
})
