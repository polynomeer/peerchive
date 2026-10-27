/**
 * 시나리오 V의 화면 부분(DELIVERY_PLAN §5.2, S-06, ADR 0034). 바깥 인터넷에 접속하지 않으므로 확인 요청(worker의 링크 수집)은 누르지 않습니다 —
 * 수집·verified·lost·사설 IP redirect 거부는 worker 테스트가 로컬 서버로 봅니다. 여기서는 설정 화면에서 링크를 넣고(내부 주소는 거부),
 * "확인 전" 상태와 넣어야 할 프로필 주소가 보이며, 방문자의 공개 프로필에 링크가 확인 표시 없이 보이고, 지우면 사라지는 것을 봅니다.
 */
import { expect, test } from '../support/fixtures'

test('V: 소셜 링크 넣기 → 확인 전 표시 → 공개 프로필에 링크 → 지우기', async ({ newUser, anon }) => {
  const student = await newUser('sora')
  const page = student.page
  await page.goto('/settings/personas')
  const editor = page.getByRole('region', { name: `실명 프로필 @${student.handle}` })
  await expect(editor.getByText(`/u/${student.handle}`)).toBeVisible()

  // 내부망 주소는 거부
  await editor.getByLabel('서비스').selectOption('blog')
  await editor.getByLabel('주소 (https://)').fill('https://192.168.0.1/')
  await editor.getByRole('button', { name: '링크 넣기' }).click()
  await expect(editor.getByText('IP 주소 대신 도메인 주소를 넣으세요.')).toBeVisible()

  const repo = `https://github.com/${student.handle}`
  await editor.getByLabel('서비스').selectOption('github')
  await editor.getByLabel('주소 (https://)').fill(repo)
  await editor.getByRole('button', { name: '링크 넣기' }).click()
  await expect(editor.getByRole('status').filter({ hasText: '링크를 넣었습니다' })).toBeVisible()
  await expect(editor.getByText('확인 전', { exact: true })).toBeVisible()
  await expect(editor.getByRole('button', { name: '확인 요청' })).toBeVisible()

  const visitor = await anon()
  await visitor.page.goto(`/u/${student.handle}`)
  const link = visitor.page.getByRole('link', { name: `GitHub · github.com/${student.handle}` })
  await expect(link).toHaveAttribute('href', repo)
  await expect(link).toHaveAttribute('rel', /nofollow/)
  await expect(visitor.page.getByText('링크 확인됨')).toHaveCount(0)

  await editor.getByRole('button', { name: '지우기' }).click()
  await expect(editor.getByRole('status').filter({ hasText: '링크를 지웠습니다' })).toBeVisible()
  await visitor.page.goto(`/u/${student.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 1 })).toContainText(student.displayName)
  await expect(visitor.page.getByRole('link', { name: /GitHub ·/ })).toHaveCount(0)
})
