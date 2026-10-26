/**
 * 시나리오 C. 팀원이 기여를 확인(DELIVERY_PLAN §5, T-08).
 * A가 로그를 근거로 역할을 선언 → B가 확인 → A가 고치면 새 버전은 "본인 설명 · 미확인"으로 돌아감.
 * owner(A)도 B의 선언은 고칠 수 없음(화면에 [고치기] 없음, API 403). 동료평가 리포트에 확인 상태가 글자로 구분됨.
 */
import { addClaim, createProject, inviteAndAccept, progressLog, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

test('C: 선언 → 팀원 확인 → 수정하면 확인 초기화, owner는 남의 선언 수정 불가', async ({ newUser }) => {
  const a = await newUser('ann')
  const b = await newUser('ben')
  const project = await createProject(a.api, { kind: 'team', title: `팀 과제 ${rand()}` })
  await inviteAndAccept(a.api, b.api, project.id, 'editor')
  const log = await progressLog(a.api, project.id, `로그인 API 구현 ${rand()}`)

  // A: UI로 선언(로그 근거)
  const claimText = `로그인 API와 입력 검증을 맡았다 ${rand()}`
  await a.page.goto(`/projects/${project.id}`)
  const declare = a.page.locator('form.claim-form').first()
  await declare.getByLabel(/내가 맡은 것/).fill(claimText)
  await declare.getByRole('group', { name: '빌드 로그 근거' }).getByRole('checkbox', { name: new RegExp(log.body!) }).check()
  await declare.getByRole('button', { name: '선언하기' }).click()
  const aClaim = a.page.getByRole('article', { name: claimText })
  await expect(aClaim.getByText('본인 설명 · 미확인')).toBeVisible()
  await expect(aClaim.getByRole('list', { name: '근거' })).toContainText(log.body!)

  // B: 확인
  await b.page.goto(`/projects/${project.id}`)
  const bView = b.page.getByRole('article', { name: claimText })
  await bView.getByRole('button', { name: '확인', exact: true }).click()
  await expect(bView.getByText('팀원 확인 1명')).toBeVisible()
  await expect(bView.getByText('내 응답: 확인함')).toBeVisible()

  // A: 고치기 → 새 버전, 확인 초기화 안내 → 미확인으로
  await a.page.reload()
  const aClaim2 = a.page.getByRole('article', { name: claimText })
  await expect(aClaim2.getByText('팀원 확인 1명')).toBeVisible()
  await aClaim2.getByRole('button', { name: '고치기' }).click()
  const revised = `${claimText} (테스트 포함)`
  await aClaim2.getByLabel(/선언 고치기/).fill(revised)
  await expect(aClaim2.getByText(/지금까지 받은 팀원 확인·이의 1건은 새 버전에 이어지지 않고/)).toBeVisible()
  await aClaim2.getByRole('button', { name: '새 버전으로 저장' }).click()
  const aRevised = a.page.getByRole('article', { name: revised })
  await expect(aRevised.getByText('본인 설명 · 미확인')).toBeVisible()
  await expect(aRevised.getByText('버전 2', { exact: false }).first()).toBeVisible()
  await expect(aRevised.getByText('팀원 확인 1명')).toHaveCount(0)

  // B의 화면도 미확인, 이전 확인은 이력에만
  await b.page.reload()
  const bRevised = b.page.getByRole('article', { name: revised })
  await expect(bRevised.getByText('본인 설명 · 미확인')).toBeVisible()
  await expect(bRevised.getByRole('button', { name: '확인', exact: true })).toBeVisible()

  // B의 선언: owner(A)에게 [고치기]가 없고 API도 403
  const bText = `발표 자료와 데모 영상 ${rand()}`
  const bClaim = await addClaim(b.api, project.id, bText)
  await a.page.reload()
  const ownerView = a.page.getByRole('article', { name: bText })
  await expect(ownerView).toBeVisible()
  await expect(ownerView.getByRole('button', { name: '고치기' })).toHaveCount(0)
  await expect(ownerView.getByRole('button', { name: '확인', exact: true })).toBeVisible()
  const forbidden = await a.api.raw('POST', `/api/v1/claims/${bClaim.id}/revisions`, { expectedRevision: 1, text: '남이 고친 선언' })
  expect(forbidden.status()).toBe(403)

  // 동료평가 리포트: 상태가 글자로 구분됨
  await a.page.goto(`/projects/${project.id}/report`)
  await expect(a.page.getByRole('heading', { level: 1, name: project.title })).toBeVisible()
  const report = a.page.locator('.report-claim')
  await expect(report.filter({ hasText: revised })).toContainText('본인 설명 · 미확인')
  await expect(report.filter({ hasText: bText })).toContainText('본인 설명 · 미확인')
})
