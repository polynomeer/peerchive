/**
 * E-10 로그별 피드백 댓글(DELIVERY_PLAN §4.4 E-10, ADR 0054). 팀원이 로그 아래 댓글 스레드를 펼쳐 피드백을 남기고,
 * 다른 팀원이 개수와 내용을 보며, 팀 밖 사용자는 API에서 404를 받습니다. 권한·숨김·삭제·보관·공개 제외는 web 통합 테스트가 덮습니다.
 */
import type { LogCommentListDto } from '../../web/shared/types/api'
import { createProject, inviteAndAccept, progressLog, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('E-10: 팀원이 로그에 피드백 댓글을 남기면 다른 팀원이 보고, 팀 밖 사용자는 404', async ({ newUser }) => {
  const owner = await newUser('owner')
  const member = await newUser('member')
  const project = await createProject(owner.api, { title: `피드백 ${rand()}`, kind: 'team' })
  await inviteAndAccept(owner.api, member.api, project.id, 'reviewer')
  const log = await progressLog(owner.api, project.id, `파서 완성 ${rand()}`)

  // 팀원(reviewer): 접힌 개수 → 펼쳐서 남기기.
  const { page } = member
  await page.goto(`/projects/${project.id}`)
  const item = page.locator(`#log-${log.id}`)
  await item.getByRole('button', { name: '피드백 댓글 0개' }).click()
  const thread = item.getByRole('region', { name: /^피드백 댓글/ })
  await expect(thread.getByText('아직 댓글이 없습니다.')).toBeVisible()
  const text = `테스트 케이스도 남겨 주세요 ${rand()}`
  await thread.getByLabel('피드백 남기기').fill(text)
  await thread.getByRole('button', { name: '댓글 남기기' }).click()
  await expect(thread.getByRole('status')).toHaveText('댓글을 남겼습니다.')
  await expect(thread.getByRole('list', { name: '댓글 목록 (오래된 순)' }).getByText(text)).toBeVisible()

  // owner: 다시 열면 개수와 내용, 숨기기 버튼.
  await owner.page.goto(`/projects/${project.id}`)
  const ownerItem = owner.page.locator(`#log-${log.id}`)
  await ownerItem.getByRole('button', { name: '피드백 댓글 1개' }).click()
  await expect(ownerItem.getByText(text)).toBeVisible()
  await expect(ownerItem.getByRole('button', { name: '숨기기' })).toBeVisible()

  // 팀 밖 사용자: 댓글 API 404.
  const stranger = await newUser('stranger')
  const res = await stranger.api.raw('GET', `/api/v1/logs/${log.id}/comments`)
  expect(res.status()).toBe(404)
  const post = await stranger.api.raw('POST', `/api/v1/logs/${log.id}/comments`, { body: '몰래' })
  expect(post.status()).toBe(404)
  const list = await member.api.get<LogCommentListDto>(`/api/v1/logs/${log.id}/comments`)
  expect(list.items.map((c) => c.body)).toEqual([text])
})
