/**
 * E-09 칸반 보드 보기(DELIVERY_PLAN §4.4 E-09, ADR 0053). 리스트 ↔ 보드 전환(이 기기에 기억), 상태별 열과 카드(제목·담당자·마감일).
 * 카드의 "옮기기" 메뉴(버튼)와 Shift + 방향키(키보드)로 옮긴 결과가 리스트 보기·API 순서와 같고, 완료 열로 옮기면
 * 리스트와 같은 완료 프롬프트가 뜹니다. 드래그(HTML5 끌어 놓기)는 데스크톱에서 Playwright dragTo로 확인하고,
 * 놓는 자리 계산은 domain 단위 테스트(`dropTarget`)가 덮습니다. 자리 지정 API의 권한·검증은 web 통합 테스트가 덮습니다.
 */
import type { TaskDto } from '../../web/shared/types/api'
import { addTask, createProject, rand, type Api } from '../support/api'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'

async function savedOrder(api: Api, projectId: string): Promise<Record<string, string[]>> {
  const list = await api.get<TaskDto[]>(`/api/v1/projects/${projectId}/tasks`)
  const out: Record<string, string[]> = { todo: [], doing: [], done: [] }
  for (const t of [...list].sort((a, b) => a.position - b.position)) out[t.status]!.push(t.id)
  return out
}

test('E-09: 보드에서 버튼·키보드로 옮기면 리스트와 같은 순서·상태가 되고, 완료 열로 옮기면 완료 프롬프트가 뜬다', async ({ newUser }) => {
  const { page, api } = await newUser('board')
  const project = await createProject(api, { title: `보드 ${rand()}` })
  const [t1, t2, t3] = [
    await addTask(api, project.id, `자료 조사 ${rand(2)}`),
    await addTask(api, project.id, `와이어프레임 ${rand(2)}`),
    await addTask(api, project.id, `발표 연습 ${rand(2)}`),
  ]
  await page.goto(`/projects/${project.id}`)

  // 보드로 전환하면 이 기기에 기억합니다.
  await page.getByRole('button', { name: '보드 보기' }).click()
  await expect(page.getByRole('button', { name: '보드 보기' })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  const board = page.getByRole('region', { name: '할 일 보드 (상태별 열)' })
  await expect(board).toBeVisible()
  const column = (name: string) => board.getByRole('list', { name: new RegExp(`^${name} \\(`) })
  const cardTitles = (name: string) => column(name).locator('h4.task-title').allTextContents()
  await expect(column('할 일').locator('h4.task-title')).toHaveText([t1.title, t2.title, t3.title])
  const status = page.getByRole('status').filter({ hasText: '옮겼습니다' })

  // 버튼: t1의 "옮기기" → 오른쪽 열로 → 진행 중 1번째, 포커스는 카드로 돌아옵니다.
  await page.getByRole('button', { name: `${t1.title} 옮기기` }).click()
  await page.getByRole('group', { name: `${t1.title} 옮기기` }).getByRole('button', { name: '오른쪽 열로' }).click()
  await expect(status).toHaveText(`‘${t1.title}’을(를) 진행 중 열 1번째로 옮겼습니다.`)
  await expect(page.locator(`#task-${t1.id}-card`)).toBeFocused()
  await expect(column('진행 중').locator('h4.task-title')).toHaveText([t1.title])

  // 키보드: t3 카드에서 Shift+↑ (할 일 1번째), Shift+→ (진행 중 1번째, t1 앞).
  await page.locator(`#task-${t3.id}-card`).focus()
  await page.keyboard.press('Shift+ArrowUp')
  await expect(status).toHaveText(`‘${t3.title}’을(를) 할 일 열 1번째로 옮겼습니다.`)
  await expect(page.locator(`#task-${t3.id}-card`)).toBeFocused()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(status).toHaveText(`‘${t3.title}’을(를) 진행 중 열 1번째로 옮겼습니다.`)
  await expect(page.locator(`#task-${t3.id}-card`)).toBeFocused()
  expect(await cardTitles('할 일')).toEqual([t2.title])
  expect(await cardTitles('진행 중')).toEqual([t3.title, t1.title])
  expect(await savedOrder(api, project.id)).toEqual({ todo: [t2.id], doing: [t3.id, t1.id], done: [] })

  // 리스트 보기에도 같은 상태·순서.
  await page.getByRole('button', { name: '리스트 보기' }).click()
  const section = page.locator('section[aria-labelledby="tasks-heading"]')
  await expect(section.getByRole('list', { name: /^진행 중 \(/ }).locator('h4.task-title')).toHaveText([t3.title, t1.title])
  await expect(section.getByRole('list', { name: /^할 일 \(/ }).locator('h4.task-title')).toHaveText([t2.title])
  await page.getByRole('button', { name: '보드 보기' }).click()

  // 완료 열로(Shift+→): 리스트와 같은 완료 프롬프트. 그냥 완료로 닫으면 포커스는 카드로.
  await page.locator(`#task-${t1.id}-card`).focus()
  await page.keyboard.press('Shift+ArrowRight')
  const question = page.getByText(`‘${t1.title}’ 완료! 막힌 적 있었나요? 결정할 게 있었나요?`)
  await expect(question).toBeVisible()
  await expect(question).toBeFocused()
  await expect(status).toContainText(`‘${t1.title}’을(를) 완료 열 1번째로 옮겼습니다.`)
  expect(await cardTitles('완료')).toEqual([t1.title])
  await page.getByRole('button', { name: '그냥 완료', exact: true }).click()
  await expect(question).toBeHidden()
  await expect(page.locator(`#task-${t1.id}-card`)).toBeFocused()
  const saved = await api.get<TaskDto[]>(`/api/v1/projects/${project.id}/tasks`)
  expect(saved.find((t) => t.id === t1.id)).toMatchObject({ status: 'done', position: 1, log: null })

  // 좁은 화면에서도 페이지 가로 스크롤 없음(보드만 스크롤).
  await expectNoHorizontalScroll(page)
})

test('E-09: 보드에서 카드를 끌어 다른 열·다른 카드 앞에 놓는다(데스크톱)', async ({ newUser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'HTML5 끌어 놓기는 데스크톱 마우스에서만 확인합니다(모바일은 버튼·키보드 대안).')
  const { page, api } = await newUser('drag')
  const project = await createProject(api, { title: `보드 드래그 ${rand()}` })
  const [t1, t2, t3] = [
    await addTask(api, project.id, `기획 ${rand(2)}`),
    await addTask(api, project.id, `구현 ${rand(2)}`),
    await addTask(api, project.id, `검증 ${rand(2)}`),
  ]
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('button', { name: '보드 보기' }).click()
  const board = page.getByRole('region', { name: '할 일 보드 (상태별 열)' })
  const status = page.getByRole('status').filter({ hasText: '옮겼습니다' })

  // t3을 진행 중 열(빈 열)로.
  await page.locator(`#task-${t3.id}-card`).dragTo(board.locator('section').filter({ has: page.getByRole('heading', { name: /^진행 중/ }) }))
  await expect(status).toHaveText(`‘${t3.title}’을(를) 진행 중 열 1번째로 옮겼습니다.`)
  // t2를 t1 카드 위쪽에 놓으면 t1 앞(할 일 1번째).
  await page.locator(`#task-${t2.id}-card`).dragTo(page.locator(`#task-${t1.id}-card`), { targetPosition: { x: 10, y: 4 } })
  await expect(status).toHaveText(`‘${t2.title}’을(를) 할 일 열 1번째로 옮겼습니다.`)
  expect(await savedOrder(api, project.id)).toEqual({ todo: [t2.id, t1.id], doing: [t3.id], done: [] })
})
