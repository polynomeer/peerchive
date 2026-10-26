/**
 * 시나리오 A. GitHub 없이 개인 과제 기록(DELIVERY_PLAN §5).
 * 이메일로 가입 → 비공개 과제 → PDF 업로드와 한 줄 로그 → 다시 열어도 유지.
 * 익명·다른 사용자에게는 보이지 않고(404), 검색 API에도 나오지 않으며, GitHub 연결을 요구하는 화면이 없습니다.
 */
import { pdfBytes, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('A: 이메일 가입 → 비공개 과제에 PDF·한 줄 로그, 남에게는 404', async ({ newUser, anon }) => {
  const owner = await newUser('alice')
  const { page } = owner
  await expect(page.getByRole('heading', { level: 1, name: '내 과제' })).toBeVisible()
  await expect(page.getByText(/github/i)).toHaveCount(0)

  // 과제 만들기(UI)
  const title = `개인 과제 ${rand()}`
  await page.getByLabel('과제 이름').fill(title)
  await page.getByRole('button', { name: '만들기' }).click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/)
  const projectPath = new URL(page.url()).pathname
  const projectId = projectPath.split('/').pop()!
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByText('🔒 팀만 보기').first()).toBeVisible()

  // PDF 업로드(UI) → worker 검사 후 사용 가능
  const fileName = `report-${rand()}.pdf`
  await page.getByLabel('새 산출물 올리기').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: pdfBytes() })
  const artifact = page.getByRole('article', { name: `📎 ${fileName}` })
  await expect(artifact).toBeVisible()
  await expect(artifact.getByText('사용 가능').first()).toBeVisible({ timeout: 30_000 })
  await expect(artifact.getByRole('link', { name: /PDF 내려받기/ })).toBeVisible()

  // 한 줄 로그(UI)
  const line = `오늘 요구사항 정리 ${rand()}`
  const composer = page.getByRole('form', { name: '빌드 로그 쓰기' })
  await composer.getByLabel('내용 (필수)').fill(line)
  await composer.getByRole('button', { name: '기록하기' }).click()
  await expect(composer.getByRole('status')).toHaveText('저장됨')
  const timeline = page.getByRole('list', { name: '로그 목록 (최신순)' })
  await expect(timeline.getByText(line)).toBeVisible()

  // 다시 열어도 유지
  await page.reload()
  await expect(page.getByRole('list', { name: '로그 목록 (최신순)' }).getByText(line)).toBeVisible()
  await expect(page.getByRole('article', { name: `📎 ${fileName}` }).getByText('사용 가능').first()).toBeVisible()
  await expect(page.getByText(/github/i)).toHaveCount(0)

  // 익명: 화면은 로그인으로, API는 401/404, 검색에도 없음
  const visitor = await anon()
  await visitor.page.goto(projectPath)
  await expect(visitor.page).toHaveURL(/\/login/)
  const anonApi = await visitor.api.raw('GET', `/api/v1/projects/${projectId}`)
  expect([401, 404]).toContain(anonApi.status())
  const search = await visitor.api.raw('GET', `/api/v1/public/search?q=${encodeURIComponent(line)}`)
  expect(search.ok()).toBeTruthy()
  expect(((await search.json()) as { results: unknown[] }).results).toEqual([])

  // 다른 사용자: 404 화면
  const other = await newUser('bob')
  await other.page.goto(projectPath)
  await expect(other.page.getByRole('heading', { level: 1, name: '과제를 찾을 수 없습니다' })).toBeVisible()
  await expect(other.page.getByText(line)).toHaveCount(0)
  expect((await other.api.raw('GET', `/api/v1/projects/${projectId}`)).status()).toBe(404)
  expect((await other.api.raw('GET', `/api/v1/projects/${projectId}/logs`)).status()).toBe(404)
})
