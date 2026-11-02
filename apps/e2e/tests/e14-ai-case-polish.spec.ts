/**
 * E-14 AI 케이스 다듬기(DELIVERY_PLAN §4.4 E-14, ADR 0059). E2E 서버에는 AI 공급자(PEERCHIVE_AI_ENABLED·ANTHROPIC_API_KEY)가 없으므로
 * 꺼진 상태만 확인합니다(네트워크 없음): features.ai false, 새 경로 모두 404, 케이스 편집 화면에 "AI로 다듬기"가 없고 템플릿 흐름(게시·공개 프로필)은 그대로,
 * 공개 프로필에 "AI로 다듬음" 표시 없음. 켜진 상태(보내는 범위·없는 인용 → 출처 없음·문장마다 받아들이기·게시 막힘·공개 표시·거절 503·한도)는
 * web 통합 테스트(ai-case-polish)와 domain 테스트가 덮습니다.
 */
import type { CaseStudyDto, FeatureFlagsDto } from '../../web/shared/types/api'
import { featureCaseStudy } from '../support/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('E-14: AI 공급자가 없으면(기본) 다듬기 버튼이 없고 새 API는 404, 템플릿 케이스는 그대로 공개된다', async ({ newUser, anon }) => {
  const student = await newUser('polish')
  const pub = await publishCase(student, { stuck: true })
  const { caseStudy } = await featureCaseStudy(student.api, pub.slug)

  expect((await student.api.get<FeatureFlagsDto>('/api/v1/features')).ai).toBe(false)
  const base = `/api/v1/case-studies/${caseStudy.id}/ai-polish`
  for (const [method, path, body] of [
    ['GET', base, undefined],
    ['POST', base, { expectedVersion: caseStudy.version }],
    ['POST', `${base}/apply`, { expectedVersion: caseStudy.version, accept: [] }],
    ['DELETE', base, undefined],
  ] as const) {
    expect((await student.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }
  expect((await student.api.get<CaseStudyDto>(`/api/v1/case-studies/${caseStudy.id}`)).generator).toBe('template')

  await student.page.goto(`/portfolio/case-studies/${caseStudy.id}`)
  await expect(student.page.getByRole('heading', { level: 1, name: '케이스 스터디 편집' })).toBeVisible()
  await expect(student.page.getByText('템플릿 초안')).toBeVisible()
  await expect(student.page.getByTestId('ai-polish')).toHaveCount(0)
  await expect(student.page.getByRole('button', { name: 'AI로 다듬기' })).toHaveCount(0)

  const visitor = await anon()
  await visitor.page.goto(`/u/${student.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 3, name: caseStudy.title })).toBeVisible()
  await expect(visitor.page.getByTestId('ai-polished')).toHaveCount(0)
})
