/**
 * 시나리오 D. 엠바고와 공동 자료 공개(DELIVERY_PLAN §5, T-10~T-12).
 * - 학기가 끝나지 않은 과목의 과제: 공개 후보를 만들 수 없음(화면 안내 + 서버 409 embargo_active).
 * - 학기가 끝난 과목의 팀 과제: owner가 후보를 만들어도 팀원 동의 전에는 게시 불가 → 동의 → 게시.
 *   작업 공간의 고르지 않은 로그는 공개 응답에 없음.
 */
import type { PublicPublicationDto } from '../../web/shared/types/api'
import { createCandidate, createProject, futureTerm, inviteAndAccept, pastTerm, progressLog, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('D1: 학기 진행 중(엠바고) 과제는 공개 후보를 만들 수 없다', async ({ newUser }) => {
  const owner = await newUser('dana')
  const term = await futureTerm(owner.api)
  const project = await createProject(owner.api, { title: `진행 중 과제 ${rand()}`, courseTermId: term.termId })
  await progressLog(owner.api, project.id, `중간 진행 ${rand()}`)

  await owner.page.goto(`/projects/${project.id}/publish`)
  await expect(owner.page.getByRole('heading', { level: 1, name: '공개 준비' })).toBeVisible()
  await expect(owner.page.getByText('이 과제는 엠바고 중이라 공개 후보를 만들 수 없습니다.')).toBeVisible()
  await expect(owner.page.getByRole('button', { name: '후보 만들고 동의 요청' })).toBeDisabled()

  const res = await owner.api.raw('POST', `/api/v1/projects/${project.id}/publication-candidates`, {
    level: 'summary',
    title: '엠바고 우회 시도',
    summary: '요약',
    slug: `e2e-${rand(6)}`,
    consentSelf: true,
  })
  expect(res.status()).toBe(409)
  expect(await res.text()).toContain('embargo_active')
})

test('D2: 학기 종료 뒤 후보 → 팀원 미동의로 게시 불가 → 동의 → 게시', async ({ newUser, anon }) => {
  const a = await newUser('owen')
  const b = await newUser('beth')
  const term = await pastTerm(a.api)
  const project = await createProject(a.api, { kind: 'team', title: `지난 학기 팀 과제 ${rand()}`, courseTermId: term.termId })
  await inviteAndAccept(a.api, b.api, project.id, 'editor')
  const aLog = `API 서버 배포 ${rand()}`
  const bLog = `화면 시안 확정 ${rand()}`
  const secretLog = `팀 내부 메모: 발표 연습 ${rand()}`
  await progressLog(a.api, project.id, aLog)
  await progressLog(b.api, project.id, bLog)
  await progressLog(a.api, project.id, secretLog)

  // owner: 화면에서 후보 만들기(두 로그만, 본인 동의)
  const slug = `e2e-${rand(6)}`
  const publicTitle = `팀 사례 ${rand()}`
  const { page } = a
  await page.goto(`/projects/${project.id}/publish`)
  await page.getByLabel(/공개 제목/).fill(publicTitle)
  await page.getByLabel(/학생이 쓴 요약/).fill('로그인과 배포를 맡은 팀 과제입니다.')
  await page.getByLabel('공개 주소').fill(slug)
  const logs = page.getByRole('group', { name: '로그' })
  await logs.getByRole('checkbox', { name: new RegExp(aLog) }).check()
  await logs.getByRole('checkbox', { name: new RegExp(bLog) }).check()
  await page.getByRole('checkbox', { name: /나도 이 공개 내용에 동의합니다/ }).check()
  await page.getByRole('button', { name: '후보 만들고 동의 요청' }).click()

  const candidateCard = page.getByRole('region', { name: /현재 후보/ })
  await expect(candidateCard).toBeVisible()
  await expect(candidateCard.getByRole('heading', { name: '게시를 막는 것' })).toBeVisible()
  await expect(candidateCard.getByText('게시 준비 완료')).toHaveCount(0)
  const publishButton = candidateCard.getByRole('button', { name: '게시', exact: true })
  await expect(publishButton).toBeDisabled()

  // 게시 전: 익명 조회 404
  const visitor = await anon()
  expect((await visitor.api.raw('GET', `/api/v1/public/publications/${slug}`)).status()).toBe(404)

  // B: 동의 요청 화면에서 동의
  await b.page.goto('/consents')
  await b.page.getByRole('listitem').filter({ hasText: publicTitle }).getByRole('link', { name: '미리보기·결정' }).click()
  const decision = b.page.getByRole('region', { name: '내 결정' })
  await expect(decision).toContainText('내 동의: 응답 대기')
  await decision.getByRole('button', { name: '이 내용 공개에 동의' }).click()
  await expect(decision).toContainText('내 동의: 동의함')

  // owner: 게시
  await page.reload()
  const ready = page.getByRole('region', { name: /현재 후보/ })
  await expect(ready.getByText('모든 동의와 파일 검사가 끝났습니다. 게시 준비 완료.')).toBeVisible()
  await ready.getByRole('button', { name: '게시', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '이 내용으로 게시할까요?' })
  await dialog.getByRole('button', { name: '게시', exact: true }).click()
  await expect(page.getByText(/공개 버전 v1/).first()).toBeVisible()

  // 익명: 공개 페이지에 고른 로그만
  await visitor.page.goto(`/p/${slug}`)
  await expect(visitor.page.getByRole('heading', { name: publicTitle })).toBeVisible()
  await expect(visitor.page.getByText(aLog, { exact: true })).toBeVisible()
  await expect(visitor.page.getByText(bLog, { exact: true })).toBeVisible()
  await expect(visitor.page.getByText(secretLog)).toHaveCount(0)
  const json = await visitor.api.get<PublicPublicationDto>(`/api/v1/public/publications/${slug}`)
  expect(JSON.stringify(json)).not.toContain(secretLog)
})

test('D3: 후보를 만든 뒤 내용이 바뀌면(새 후보) 이전 동의로 게시할 수 없다', async ({ newUser }) => {
  const a = await newUser('omar')
  const term = await pastTerm(a.api)
  const project = await createProject(a.api, { title: `해시 확인 ${rand()}`, courseTermId: term.termId })
  const log = await progressLog(a.api, project.id, `첫 기록 ${rand()}`)
  const first = await createCandidate(a.api, project.id, { level: 'summary', logIds: [log.id] })
  const second = await createCandidate(a.api, project.id, { level: 'summary', logIds: [], slug: first.slug })
  // 대체된 후보로 게시 시도 → 409
  const stale = await a.api.raw('POST', `/api/v1/candidates/${first.id}/publish`, { manifestHash: first.manifestHash })
  expect(stale.status()).toBe(409)
  expect(second.id).not.toBe(first.id)
})
