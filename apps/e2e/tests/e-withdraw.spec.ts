/**
 * 시나리오 E. 철회와 파생 데이터(DELIVERY_PLAN §5, T-12·T-14).
 * owner가 공개를 철회하면 그 즉시 공개 페이지·공개 파일 URL이 404이고, 공개 프로필의 대표 케이스 스터디는 "볼 수 없음"으로 바뀝니다.
 * 철회 안내에는 이미 받은 사본은 회수할 수 없다는 문구가 있습니다.
 */
import { featureCaseStudy } from '../support/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('E: 철회 즉시 공개 페이지·파일 404, 포트폴리오 항목은 볼 수 없음', async ({ newUser, anon }) => {
  const owner = await newUser('erin')
  const pub = await publishCase(owner, { withPdf: true })
  const { caseStudy } = await featureCaseStudy(owner.api, pub.slug)
  const fileUrl = `/api/v1/public/publications/${pub.slug}/artifacts/${pub.pdf!.versionId}`

  // 철회 전: 익명으로 페이지·파일·프로필 확인
  const visitor = await anon()
  await visitor.page.goto(`/p/${pub.slug}`)
  await expect(visitor.page.getByRole('heading', { name: pub.title })).toBeVisible()
  await expect(visitor.page.getByRole('link', { name: pub.pdf!.fileName })).toBeVisible()
  const before = await visitor.api.raw('GET', fileUrl)
  expect(before.status()).toBe(200)
  expect((await before.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  await visitor.page.goto(`/u/${owner.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 3, name: caseStudy.title })).toBeVisible()

  // owner: 화면에서 철회
  await owner.page.goto(`/projects/${pub.projectId}/publish`)
  await owner.page.getByRole('button', { name: '공개 철회' }).click()
  const dialog = owner.page.getByRole('dialog', { name: '공개를 철회할까요?' })
  await expect(dialog).toContainText('회수')
  await dialog.getByLabel(/사유/).fill('E2E 철회 확인')
  await dialog.getByRole('button', { name: '철회', exact: true }).click()
  await expect(owner.page.getByText('철회됨').first()).toBeVisible()

  // 즉시: 공개 페이지·JSON·파일 404 (worker 처리와 무관)
  const page = await visitor.page.goto(`/p/${pub.slug}`)
  expect(page?.status()).toBe(404)
  await expect(visitor.page.getByRole('heading', { level: 1, name: '공개 사례를 찾을 수 없습니다' })).toBeVisible()
  expect((await visitor.api.raw('GET', `/api/v1/public/publications/${pub.slug}`)).status()).toBe(404)
  expect((await visitor.api.raw('GET', fileUrl)).status()).toBe(404)

  // 포트폴리오: 대표 케이스 스터디는 볼 수 없음 표시(내용 없음)
  await visitor.page.goto(`/u/${owner.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 3, name: '볼 수 없는 케이스 스터디' })).toBeVisible()
  await expect(visitor.page.getByText(caseStudy.title)).toHaveCount(0)
  await expect(visitor.page.getByText(pub.progressText)).toHaveCount(0)

  // 과목 허브에서도 빠짐
  await visitor.page.goto(`/c/${pub.courseId}`)
  await expect(visitor.page.getByRole('heading', { level: 1, name: new RegExp(pub.courseTitle) })).toBeVisible()
  await expect(visitor.page.getByText(pub.title)).toHaveCount(0)
})
