/**
 * E-05 유사 막힘 의미 검색(DELIVERY_PLAN §4.4 E-05, ADR 0055). E2E 서버에는 임베딩 공급자(`PEERCHIVE_EMBEDDINGS_PROVIDER`·`VOYAGE_API_KEY`)가 없으므로
 * 꺼진 상태만 확인합니다: features.semanticStuck false, 사례 페이지에 "비슷한 막힘"이 없고 검색 화면에 "의미로 찾기"가 없으며 두 API는 404,
 * 키워드 검색은 그대로 동작. 켜진 상태(정렬·철회·가림·엠바고 제외·검색어 비저장·한도)는 web 통합 테스트(semantic-stuck)와 worker 테스트가 덮습니다.
 */
import type { FeatureFlagsDto, PublicPublicationDto } from '../../web/shared/types/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('E-05: 임베딩 공급자가 없으면(기본) 비슷한 막힘·의미로 찾기가 없고 API는 404, 키워드 검색은 그대로', async ({ newUser, anon }) => {
  const senior = await newUser('sem')
  const pub = await publishCase(senior, { stuck: true })
  const visitor = await anon()
  const publicCase = await visitor.api.get<PublicPublicationDto>(`/api/v1/public/publications/${pub.slug}`)
  const key = publicCase.snapshot.logs.find((l) => l.tag === 'stuck')!.key

  expect((await visitor.api.get<FeatureFlagsDto>('/api/v1/features')).semanticStuck).toBe(false)
  expect((await visitor.api.raw('GET', `/api/v1/public/publications/${pub.slug}/stuck/${encodeURIComponent(key)}/similar`)).status()).toBe(404)
  expect((await visitor.api.raw('GET', `/api/v1/public/search/semantic?q=${encodeURIComponent('좀비 프로세스')}`)).status()).toBe(404)

  await visitor.page.goto(`/p/${pub.slug}`)
  await expect(visitor.page.getByRole('heading', { level: 1, name: pub.title })).toBeVisible()
  await expect(visitor.page.getByTestId('case-similar-stuck')).toHaveCount(0)

  // mode=semantic을 붙여도 키워드 검색 화면 그대로입니다.
  await visitor.page.goto(`/search?q=${encodeURIComponent(pub.title)}&mode=semantic`)
  await expect(visitor.page.getByRole('heading', { level: 1, name: '검색' })).toBeVisible()
  await expect(visitor.page.getByTestId('semantic-toggle')).toHaveCount(0)
  await expect(visitor.page.getByRole('navigation', { name: '결과 종류' })).toBeVisible()
})
