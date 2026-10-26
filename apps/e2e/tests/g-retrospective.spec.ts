/**
 * 시나리오 G. 사후 작성(DELIVERY_PLAN §5, T-07).
 * 지난 과제를 사후 작성 모드로 만들면 그 과제·로그·마일스톤에 `사후 작성`이 표시되고, 공개 화면까지 이어집니다.
 * 자기 기입 날짜(기억·파일 기준 날짜)와 기록 시각은 따로 보입니다.
 */
import type { LogPageDto, MilestoneDto } from '../../web/shared/types/api'
import { createCandidate, publish, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('G: 사후 작성 표시가 과제 공간에서 공개 페이지까지 유지', async ({ newUser, anon }) => {
  const grad = await newUser('gina')
  const { page, api } = grad

  // 화면에서 사후 작성 과제 만들기
  const title = `2024 캡스톤 되짚기 ${rand()}`
  await page.getByLabel('과제 이름').fill(title)
  await page.getByRole('checkbox', { name: /지난 과제 되짚기\(사후 작성\)/ }).check()
  await page.getByRole('button', { name: '만들기' }).click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/)
  const projectId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.locator('h1 + p .badge.retro')).toHaveText('사후 작성')

  // 마일스톤(사후 작성)
  const msTitle = `최종 발표 ${rand(2)}`
  await page.getByText('새 마일스톤 추가').click()
  const msForm = page.getByRole('form', { name: '새 마일스톤 추가' })
  await msForm.getByLabel(/이름 \(필수/).fill(msTitle)
  await msForm.getByLabel('기억·파일 기준 날짜(자기 기입)').fill('2024-06-14')
  await msForm.getByRole('button', { name: '추가' }).click()
  const msItem = page.getByRole('list', { name: '마일스톤 (순서대로)' }).getByRole('listitem').filter({ hasText: msTitle })
  await expect(msItem.locator('.badge.retro').first()).toHaveText('사후 작성')

  // 로그(사후 작성, 기억·파일 기준 날짜가 맨 위)
  const body = `발표 자료 v3를 보고 정리한 회고 ${rand()}`
  const composer = page.getByRole('form', { name: '빌드 로그 쓰기' })
  await composer.getByLabel('기억·파일 기준 날짜(자기 기입)').fill('2024-06-10')
  await composer.getByLabel('내용 (필수)').fill(body)
  await composer.getByRole('button', { name: '기록하기' }).click()
  await expect(composer.getByRole('status')).toHaveText('저장됨')
  const logItem = page.getByRole('list', { name: '로그 목록 (최신순)' }).getByRole('listitem').filter({ hasText: body })
  await expect(logItem.getByText('사후 작성', { exact: true })).toBeVisible()
  await expect(logItem).toContainText('기억·파일 기준 날짜(자기 기입) 2024-06-10')

  // 게시(준비 단계라 API) → 공개 화면
  const logs = await api.get<LogPageDto>(`/api/v1/projects/${projectId}/logs`)
  const ms = await api.get<MilestoneDto[]>(`/api/v1/projects/${projectId}/milestones`)
  expect(logs.items[0]!.retrospective).toBe(true)
  const candidate = await createCandidate(api, projectId, {
    level: 'full',
    logIds: logs.items.map((l) => l.id),
    milestoneIds: ms.map((m) => m.id),
    exposure: { [grad.id]: 'name' },
  })
  await publish(api, candidate)

  const visitor = await anon()
  await visitor.page.goto(`/p/${candidate.slug}`)
  const snapshot = visitor.page.locator('article.public-snapshot')
  await expect(snapshot.locator('header .badge.retro')).toHaveText('사후 작성')
  const publicLog = snapshot.locator('li.snapshot-log').filter({ hasText: body })
  await expect(publicLog.locator('.badge.retro')).toHaveText('사후 작성')
  await expect(publicLog).toContainText('수행일(자기 기입) ')
  await expect(publicLog).toContainText('기록 ')
  const publicMs = snapshot.locator('li').filter({ hasText: msTitle }).first()
  await expect(publicMs.locator('.badge.retro')).toHaveText('사후 작성')
  await expect(publicMs).toContainText('도달(자기 기입)')
  // 공개 JSON에도 표시가 남음
  const json = await visitor.api.get<{ snapshot: { retrospective: boolean; logs: Array<{ retrospective: boolean }> } }>(
    `/api/v1/public/publications/${candidate.slug}`,
  )
  expect(json.snapshot.retrospective).toBe(true)
  expect(json.snapshot.logs.every((l) => l.retrospective)).toBe(true)
})
