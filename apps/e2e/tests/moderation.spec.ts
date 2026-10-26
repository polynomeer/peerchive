/**
 * 신고·관리 조치 smoke(T-15). 로그인한 사용자가 공개 사례의 기록 하나를 신고 → 운영자(CLI로 부여)가
 * "항목 하나 가리기"로 처리 → 공개 페이지에는 그 자리에 "운영 조치로 가려진 항목"만 보입니다.
 */
import { rand } from '../support/api'
import { grantOperator } from '../support/db'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('신고 → 운영자 hide_item → 공개 페이지에 가림 표시', async ({ newUser, anon }) => {
  const owner = await newUser('mona')
  const pub = await publishCase(owner, { stuck: true })
  const reporter = await newUser('rex')
  const operator = await newUser('opal')
  grantOperator(operator.email)

  // 신고(화면)
  await reporter.page.goto(`/p/${pub.slug}`)
  await reporter.page.getByRole('button', { name: '이 사례 신고하기' }).click()
  const dialog = reporter.page.getByRole('dialog', { name: '신고하기' })
  await dialog.getByLabel('무엇을 신고하나요?').selectOption({ label: `🔨 진행 기록: ${pub.progressText}` })
  await dialog.getByLabel('개인정보 노출').check()
  await dialog.getByLabel('자세한 내용(선택)').fill(`E2E 신고 ${rand()}`)
  await dialog.getByRole('button', { name: '신고 보내기' }).click()
  await expect(dialog.getByRole('status')).toContainText('신고가 접수되었습니다.')

  // 운영자(권한은 요청마다 DB에서 읽으므로 새로 연 화면에 운영 메뉴가 보임)
  await operator.page.goto('/operator')
  await operator.page.getByRole('link', { name: `공개 사례 /p/${pub.slug} · 기록` }).click()
  await operator.page.waitForURL(/\/operator\/reports\//)
  await operator.page.getByLabel('조치', { exact: true }).selectOption({ label: '항목 하나 가리기' })
  await operator.page.getByLabel('내부 메모(필수, 운영자만 봄)').fill('E2E: 개인정보 확인됨')
  await operator.page.getByLabel('당사자에게 보일 사유').fill('개인정보가 들어 있어 가렸습니다.')
  await operator.page.getByRole('button', { name: '처리하기' }).click()
  await expect(operator.page.getByText('처리했습니다.')).toBeVisible()

  // 익명: 가린 자리 표시, 원문 없음(다른 기록은 그대로)
  const visitor = await anon()
  await visitor.page.goto(`/p/${pub.slug}`)
  await expect(visitor.page.getByText('운영 조치로 가려진 항목').first()).toBeVisible()
  await expect(visitor.page.getByText(pub.progressText)).toHaveCount(0)
  await expect(visitor.page.getByText(pub.stuckSymptom!).first()).toBeVisible()
  const json = await (await visitor.api.raw('GET', `/api/v1/public/publications/${pub.slug}`)).text()
  expect(json).not.toContain(pub.progressText)
})
