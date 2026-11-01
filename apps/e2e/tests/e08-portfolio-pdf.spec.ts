/**
 * E-08 지원용 PDF(DELIVERY_PLAN §4.4 E-08, ADR 0052). 로그인하지 않은 검토자가 공개 프로필의 "PDF 내려받기"로 서버가 만든 A4 PDF를 받습니다.
 * 응답은 application/pdf 첨부·noindex·no-store입니다. PDF 글(한글·근거 주소·철회 케이스 제외·S-01)·한도·404는 web 통합 테스트가 덮습니다.
 */
import { readFile } from 'node:fs/promises'
import { featureCaseStudy } from '../support/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('E-08: 공개 프로필에서 지원용 PDF를 내려받는다', async ({ newUser, anon }) => {
  const student = await newUser('pdf')
  const pub = await publishCase(student)
  await featureCaseStudy(student.api, pub.slug)

  const visitor = await anon()
  await visitor.page.goto(`/u/${student.handle}`)
  const link = visitor.page.getByRole('link', { name: 'PDF 내려받기' })
  await expect(link).toHaveAttribute('href', `/api/v1/public/profiles/${student.handle}/portfolio.pdf`)
  const [download] = await Promise.all([visitor.page.waitForEvent('download'), link.click()])
  expect(download.suggestedFilename()).toBe(`${student.handle}-portfolio.pdf`)
  const bytes = await readFile((await download.path())!)
  expect(bytes.byteLength).toBeGreaterThan(0)
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')

  const res = await visitor.api.raw('GET', `/api/v1/public/profiles/${student.handle}/portfolio.pdf`)
  expect(res.status()).toBe(200)
  const headers = res.headers()
  expect(headers['content-type']).toBe('application/pdf')
  expect(headers['content-disposition']).toContain('attachment')
  expect(headers['x-robots-tag']).toContain('noindex')
  expect(headers['cache-control']).toBe('no-store')
  expect((await res.body()).byteLength).toBeGreaterThan(0)

  // 인쇄 보기에도 같은 링크가 있습니다.
  await visitor.page.goto(`/u/${student.handle}/print`)
  await expect(visitor.page.getByRole('link', { name: /PDF 내려받기/ })).toHaveAttribute('href', `/api/v1/public/profiles/${student.handle}/portfolio.pdf`)
})
