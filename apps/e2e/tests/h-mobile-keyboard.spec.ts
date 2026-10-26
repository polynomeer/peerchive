/**
 * 시나리오 H. 초보 학생의 기록과 접근성(DELIVERY_PLAN §5, T-04·T-06·T-07).
 * - 파일만 먼저 올리고 나중에 설명(로그)을 완성
 * - 저장 실패(오프라인) 때 입력이 사라지지 않고 "재시도"가 글자로 보이며, 재시도는 성공하고 로그는 하나
 * - 새로고침해도 저장하지 못한 입력을 불러옴
 * - 할 일·마일스톤 순서를 드래그 없이 키보드만으로 바꿈
 * 두 project(desktop 1280px, mobile 360px)에서 모두 돌고, 가로 스크롤 검사는 a11y-and-layout.spec.ts에 있습니다.
 */
import type { LogPageDto, MilestoneDto, TaskDto } from '../../web/shared/types/api'
import { addMilestone, addTask, createProject, pdfBytes, rand, type Api } from '../support/api'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

async function countLogs(api: Api, projectId: string, body: string): Promise<number> {
  const page = await api.get<LogPageDto>(`/api/v1/projects/${projectId}/logs?limit=50`)
  return page.items.filter((l) => l.body === body).length
}

test('H1: 파일 먼저 → 나중에 설명, 오프라인 저장 실패에도 입력 보존 후 재시도', async ({ newUser }) => {
  const user = await newUser('hana')
  const { page, api, context } = user
  const project = await createProject(api, { title: `모바일 기록 ${rand()}` })
  await page.goto(`/projects/${project.id}`)
  await expectNoHorizontalScroll(page)

  // 1) 파일만 먼저
  const fileName = `whiteboard-${rand()}.pdf`
  await page.getByLabel('새 산출물 올리기').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: pdfBytes() })
  const artifact = page.getByRole('article', { name: `📎 ${fileName}` })
  await expect(artifact.getByText('사용 가능').first()).toBeVisible({ timeout: 30_000 })

  // 2) 나중에 설명을 완성(다시 연 화면에서 파일을 근거로)
  await page.reload()
  const composer = page.getByRole('form', { name: '빌드 로그 쓰기' })
  const body = page.getByRole('form', { name: '빌드 로그 쓰기' }).getByLabel('내용 (필수)')
  const first = `회의 화이트보드 사진 정리 ${rand()}`
  await body.fill(first)
  await composer.getByRole('checkbox', { name: new RegExp(`${fileName} v1`) }).check()
  await composer.getByRole('button', { name: '기록하기' }).click()
  await expect(composer.getByRole('status')).toHaveText('저장됨')
  const firstItem = page.getByRole('list', { name: '로그 목록 (최신순)' }).getByRole('listitem').filter({ hasText: first })
  await expect(firstItem.getByRole('list', { name: '파일 근거' })).toContainText(fileName)

  // 3) 오프라인 → 저장 실패, 입력 보존, 글자로 된 재시도
  const second = `지하철에서 쓴 기록 ${rand()}`
  await body.fill(second)
  await context.setOffline(true)
  await composer.getByRole('button', { name: '기록하기' }).click()
  await expect(composer.getByRole('status')).toContainText('오류 — 재시도')
  await expect(body).toHaveValue(second)
  await context.setOffline(false)
  await composer.getByRole('button', { name: '재시도' }).click()
  await expect(composer.getByRole('status')).toHaveText('저장됨')
  await expect(body).toHaveValue('')
  expect(await countLogs(api, project.id, second)).toBe(1)

  // 4) 실패한 입력은 새로고침 뒤에도 남음(이 기기 임시 저장)
  const third = `배터리 나가기 전 기록 ${rand()}`
  await body.fill(third)
  await context.setOffline(true)
  await composer.getByRole('button', { name: '기록하기' }).click()
  await expect(composer.getByRole('status')).toContainText('내용은 이 기기에 임시 저장되어 있습니다')
  await context.setOffline(false)
  await page.reload()
  const restored = page.getByRole('form', { name: '빌드 로그 쓰기' })
  await expect(restored.getByRole('status')).toHaveText('저장하지 못한 입력을 불러왔습니다.')
  await expect(restored.getByLabel('내용 (필수)')).toHaveValue(third)
  await restored.getByRole('button', { name: '기록하기' }).click()
  await expect(restored.getByRole('status')).toHaveText('저장됨')
  expect(await countLogs(api, project.id, third)).toBe(1)
  await expectNoHorizontalScroll(page)
})

test('H2: 할 일·마일스톤 순서를 키보드만으로 바꾸기', async ({ newUser }) => {
  const user = await newUser('kim')
  const { page, api } = user
  const project = await createProject(api, { title: `키보드 순서 ${rand()}` })
  const tasks = [] as Array<{ id: string; title: string }>
  for (const t of ['자료 조사', '와이어프레임', '발표 연습']) tasks.push(await addTask(api, project.id, `${t} ${rand(2)}`))
  const ms = [] as Array<{ id: string; title: string }>
  for (const m of ['기획', '구현', '검증']) ms.push(await addMilestone(api, project.id, `${m} ${rand(2)}`))
  await page.goto(`/projects/${project.id}`)

  // 할 일: 첫 항목의 상태 메뉴에서 Tab → (▲는 비활성이라 건너뜀) ▼ → Enter 두 번
  const [t1, t2, t3] = tasks as [(typeof tasks)[0], (typeof tasks)[0], (typeof tasks)[0]]
  await page.locator(`#task-${t1.id}-status`).focus()
  await page.keyboard.press('Tab')
  await expect(page.locator(`#task-${t1.id}-down`)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: `‘${t1.title}’을(를)` })).toContainText('2번째로 옮겼습니다')
  await expect(page.locator(`#task-${t1.id}-down`)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: `‘${t1.title}’을(를)` })).toContainText('3번째로 옮겼습니다')
  // 끝에 닿으면 포커스는 반대 방향(▲)으로
  await expect(page.locator(`#task-${t1.id}-up`)).toBeFocused()
  const titles = await page.locator('.task-list').first().locator('h4.task-title').allTextContents()
  expect(titles).toEqual([t2.title, t3.title, t1.title])
  const saved = await api.get<TaskDto[]>(`/api/v1/projects/${project.id}/tasks`)
  expect(saved.sort((a, b) => a.position - b.position).map((t) => t.id)).toEqual([t2.id, t3.id, t1.id])

  // 마일스톤: 마지막 항목을 ▲로 맨 위까지
  const [m1, m2, m3] = ms as [(typeof ms)[0], (typeof ms)[0], (typeof ms)[0]]
  const moved = page.getByRole('status').filter({ hasText: `${m3.title}을(를)` })
  await page.locator(`#ms-${m3.id}-up`).focus()
  await page.keyboard.press('Enter')
  await expect(moved).toContainText('2번째로 옮겼습니다')
  await expect(page.locator(`#ms-${m3.id}-up`)).toBeFocused()
  await page.keyboard.press('Space')
  await expect(moved).toContainText('1번째로 옮겼습니다')
  await expect(page.locator(`#ms-${m3.id}-down`)).toBeFocused()
  const list = page.getByRole('list', { name: '마일스톤 (순서대로)' })
  await expect(list.locator(':scope > li').first()).toContainText(`마일스톤 1: ${m3.title}`)
  const savedMs = await api.get<MilestoneDto[]>(`/api/v1/projects/${project.id}/milestones`)
  expect(savedMs.map((m) => m.id)).toEqual([m3.id, m1.id, m2.id])
  await expectNoHorizontalScroll(page)
})
