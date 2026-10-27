/**
 * S-07 신고 smoke(DELIVERY_PLAN §4.2 S-07·§7 GP, ADR 0036). 로그인한 사용자가 표시명 프로필을 "표시명 사칭"으로 신고 → 운영자 화면에는 그
 * 표시명 프로필 자신만 보이고(같은 사람의 실명 handle 없음) "이 프로필만 숨기기"로 처리 → 표시명 프로필만 "찾을 수 없음", 실명 프로필은 그대로.
 */
import { createDisplayPersona } from '../support/api'
import { grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'

test('표시명 사칭 신고 → 운영자는 그 프로필만 보고 숨김 → 표시명 프로필만 404, 실명 프로필은 그대로', async ({ newUser, anon }) => {
  const owner = await newUser('sora')
  const display = await createDisplayPersona(owner.api, 'imp')
  const reporter = await newUser('rhea')
  const operator = await newUser('oskar')
  grantOperator(operator.email)

  // 신고(화면): 표시명 프로필의 신고 버튼, 사칭 사유는 프로필 대상에서만 보임.
  await reporter.page.goto(`/u/${display.handle}`)
  await reporter.page.getByRole('button', { name: '신고하기' }).click()
  const dialog = reporter.page.getByRole('dialog', { name: '신고하기' })
  await expect(dialog.getByText(`대상: 공개 프로필 @${display.handle}`)).toBeVisible()
  await dialog.getByLabel('표시명 사칭(다른 사람·단체로 오인하게 함)').check()
  await expect(dialog.getByText('비슷한 이름만으로는 사칭이 아니며')).toBeVisible()
  await dialog.getByRole('button', { name: '신고 보내기' }).click()
  await expect(dialog.getByRole('status')).toContainText('신고가 접수되었습니다.')

  // 운영자: 대기열·상세에 표시명 프로필 자신만(실명 handle·이름 없음).
  await operator.page.goto('/operator')
  await operator.page.getByRole('link', { name: `공개 프로필 @${display.handle} (표시명)` }).click()
  await operator.page.waitForURL(/\/operator\/reports\//)
  await expect(operator.page.getByTestId('op-persona')).toContainText(display.displayName)
  const html = await operator.page.content()
  expect(html).not.toContain(owner.handle)
  expect(html).not.toContain(owner.displayName)
  await operator.page.getByLabel('조치', { exact: true }).selectOption({ label: '이 프로필만 숨기기(같은 사람의 다른 프로필은 그대로)' })
  await operator.page.getByLabel('내부 메모(필수, 운영자만 봄)').fill('E2E: 사칭 확인')
  await operator.page.getByLabel('당사자에게 보일 사유').fill('다른 사람으로 오인하게 하는 이름입니다.')
  await operator.page.getByRole('button', { name: '처리하기' }).click()
  await expect(operator.page.getByText('처리했습니다.')).toBeVisible()

  // 방문자: 표시명 프로필만 사라지고 실명 프로필은 그대로.
  const visitor = await anon()
  await visitor.page.goto(`/u/${display.handle}`)
  await expect(visitor.page.getByRole('heading', { name: '프로필을 찾을 수 없습니다' })).toBeVisible()
  await visitor.page.goto(`/u/${owner.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 1 })).toContainText(owner.handle)
})
