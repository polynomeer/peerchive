/**
 * 학교 메일 인증(C-01) 도우미. 운영 절차대로 CLI로 학교 메일 도메인을 등록하고, 화면에서 코드를 받아 입력합니다.
 * 코드는 dev-console 메일(서버 로그)에서 읽습니다(로그인 도우미와 같은 방식). 주소가 가려져 로그에 남으므로(첫 글자 + 도메인)
 * 학교마다 무작위 도메인을 씁니다.
 */
import { expect, type Page } from '@playwright/test'
import { type Api, rand } from './api'
import { registerSchoolDomain } from './db'
import { mailCount, waitForAffiliationCode } from './mail'

/** 학교에 무작위 메일 도메인(`e2e<무작위>.ac.kr`)을 등록하고, 그 하위 도메인의 새 주소를 돌려줍니다. */
export function schoolMailbox(schoolId: string): { domain: string; email: string } {
  const domain = `e2e${rand(4)}.ac.kr`
  registerSchoolDomain(schoolId, domain)
  return { domain, email: `s${rand(3)}@stu.${domain}` }
}

/** 지금 화면(/settings/affiliations, 학교를 이미 고른 상태)에서 코드를 받아 바로 입력합니다. */
export async function requestAndVerify(page: Page, email: string, options: { wrongFirst?: boolean } = {}): Promise<void> {
  const before = mailCount(email)
  await page.getByLabel('학교 메일 주소').fill(email)
  await page.getByRole('button', { name: '인증 코드 받기' }).click()
  await expect(page.getByRole('status').filter({ hasText: '인증 코드를 보냈습니다' })).toBeVisible()
  const code = await waitForAffiliationCode(email, before)
  const input = page.getByLabel('인증 코드 (6자리)')
  if (options.wrongFirst) {
    await input.fill(code === '000000' ? '111111' : '000000')
    await page.getByRole('button', { name: '확인', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('인증 코드가 맞지 않습니다. 남은 시도 4회.')
    await expect(page.getByText(/남은 시도 4회 · \d{2}:\d{2}까지 입력/)).toBeVisible()
  }
  await input.fill(code)
  await page.getByRole('button', { name: '확인', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '인증을 마쳤습니다' })).toBeVisible()
}

/**
 * 준비 단계(C-02 커뮤니티 시나리오용): API로 학교 메일 인증을 마칩니다. 인증 화면 자체는 affiliation.spec.ts가 확인합니다.
 * 메일 로그에서 주소가 첫 글자 + 도메인으로 가려지므로 `prefix`의 첫 글자는 같은 도메인 안에서 사람마다 달라야 합니다.
 */
export async function verifyByApi(api: Api, schoolId: string, domain: string, prefix: string): Promise<string> {
  const email = `${prefix}${rand(3)}@stu.${domain}`
  const before = mailCount(email)
  const res = await api.raw('POST', '/api/v1/me/affiliations', { schoolId, email, standing: 'student' })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()) as { id: string }
  const code = await waitForAffiliationCode(email, before)
  const verified = await api.raw('POST', `/api/v1/me/affiliations/${id}/verify`, { code })
  expect(verified.status(), await verified.text()).toBe(200)
  return email
}
