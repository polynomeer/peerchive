/**
 * 시나리오 B(디스코드 없이 바꾼 형태). 같은 기록 요청이 두 번 가도 로그는 한 번만 생깁니다.
 * - 빠른 두 번 클릭(이중 제출) → 로그 1개
 * - 서버는 저장했지만 응답이 끊긴 경우 → 화면은 "오류 — 재시도", [재시도]는 같은 clientId로 보내 로그 1개
 * (실제 디스코드 `/log` 재전송은 bot 통합 테스트가 맡습니다.)
 */
import type { LogPageDto } from '../../web/shared/types/api'
import { createProject, rand, type Api } from '../support/api'
import { expect, test } from '../support/fixtures'

async function logsWith(api: Api, projectId: string, text: string): Promise<number> {
  const page = await api.get<LogPageDto>(`/api/v1/projects/${projectId}/logs?limit=50`)
  return page.items.filter((l) => l.body === text).length
}

test('B: 이중 제출과 응답 유실 뒤 재시도에도 로그는 하나', async ({ newUser }) => {
  const owner = await newUser('bella')
  const { page, api } = owner
  const project = await createProject(api, { title: `중복 방지 ${rand()}` })
  await page.goto(`/projects/${project.id}`)
  const composer = page.getByRole('form', { name: '빌드 로그 쓰기' })
  const timeline = page.getByRole('list', { name: '로그 목록 (최신순)' })

  // 1) 빠른 두 번 클릭
  const first = `CORS 에러 원인 찾음 ${rand()}`
  await composer.getByLabel('내용 (필수)').fill(first)
  await composer.getByRole('button', { name: '기록하기' }).dblclick()
  await expect(composer.getByRole('status')).toHaveText('저장됨')
  await expect(timeline.getByText(first)).toHaveCount(1)
  expect(await logsWith(api, project.id, first)).toBe(1)

  // 2) 서버는 저장했는데 응답이 끊김 → 재시도
  const second = `프록시 설정으로 해결 ${rand()}`
  let posts = 0
  await page.route(`**/api/v1/projects/${project.id}/logs`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posts++
    if (posts === 1) {
      await route.fetch() // 서버까지는 도착(저장됨)
      return route.abort('connectionreset') // 응답은 브라우저에 오지 않음
    }
    return route.continue()
  })
  await composer.getByLabel('내용 (필수)').fill(second)
  await composer.getByRole('button', { name: '기록하기' }).click()
  await expect(composer.getByRole('status')).toContainText('오류 — 재시도')
  await expect(composer.getByLabel('내용 (필수)')).toHaveValue(second)
  expect(await logsWith(api, project.id, second)).toBe(1)

  const replay = page.waitForResponse((r) => r.url().endsWith(`/projects/${project.id}/logs`) && r.request().method() === 'POST')
  await composer.getByRole('button', { name: '재시도' }).click()
  expect((await replay).status()).toBe(200) // 같은 clientId → 이미 만든 로그를 돌려줌(새로 만들면 201)
  await expect(composer.getByRole('status')).toHaveText('저장됨')
  await expect(timeline.getByText(second)).toHaveCount(1)
  expect(await logsWith(api, project.id, second)).toBe(1)
  expect(posts).toBe(2)
})
