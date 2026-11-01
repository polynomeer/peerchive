/**
 * C-01 학교 메일 인증(DELIVERY_PLAN §4.1, ADR 0018). 화면만으로:
 * 학교 검색으로 고르기 → 다른 학교 도메인은 거부(다른 학교 도메인을 알려 주지 않음) → 학교 메일로 코드 받기 → 틀린 코드(남은 시도 4회) →
 * 맞는 코드로 인증 → 졸업생으로 바꾸기 → 공개 프로필 배지는 켤 때만, 학과·메일·도메인은 공개 화면 어디에도 없음 → 선배 노트 폼이 열림.
 */
import { pastTerm, rand } from '../support/api'
import { requestAndVerify, schoolMailbox } from '../support/affiliation'
import { expect, expectNoHorizontalScroll, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('C-01: 학교 메일 인증(틀린 코드 포함) → 졸업생 표시 → 배지 선택 → 과목 허브 작성 가능', async ({ newUser, anon }) => {
  const student = await newUser('aff')
  const pub = await publishCase(student, { stuck: false })
  const other = await pastTerm(student.api)
  const mailbox = schoolMailbox(pub.schoolId)
  const otherMailbox = schoolMailbox(other.schoolId)
  const page = student.page

  await page.goto('/settings/affiliations')
  await expect(page.getByRole('heading', { level: 1, name: '학교 인증' })).toBeVisible()
  await expect(page.getByText('아직 인증한 학교가 없습니다.')).toBeVisible()
  await page.getByLabel('학교 검색').fill(pub.schoolName)
  await page.getByRole('button', { name: pub.schoolName, exact: true }).click()
  await expect(page.getByRole('button', { name: '다른 학교 고르기' })).toBeVisible()

  // 다른 학교의 메일 도메인은 거부하고, 어느 도메인이 맞는지 알려 주지 않음.
  await page.getByLabel('학교 메일 주소').fill(`x${rand(2)}@${otherMailbox.domain}`)
  await page.getByRole('button', { name: '인증 코드 받기' }).click()
  const refused = page.getByRole('alert')
  await expect(refused).toContainText('이 학교에 등록된 메일 도메인이 아닙니다')
  await expect(refused).not.toContainText(mailbox.domain)

  const department = `비공개학과${rand(2)}`
  await page.getByLabel('학과 (선택, 공개되지 않음)').fill(department)
  await requestAndVerify(page, mailbox.email, { wrongFirst: true })
  const item = page.getByRole('listitem').filter({ hasText: pub.schoolName })
  await expect(item).toContainText('인증됨')
  await expect(item).toContainText('재학생')
  await expect(item).toContainText(department)
  await expectNoHorizontalScroll(page)

  // 졸업생으로 바꾸기(인증 이력 유지)
  await item.getByLabel('재학 상태').selectOption('alumni')
  await item.getByRole('button', { name: '저장' }).click()
  await expect(page.getByRole('status').filter({ hasText: '저장했습니다.' })).toBeVisible()
  await expect(item).toContainText('졸업생')
  await expect(item).toContainText('인증됨')

  // 공개 프로필: 배지를 켜기 전에는 없음 → 켜면 "○○ 인증 · 졸업생"만. 학과·메일·도메인은 없음.
  const visitor = await anon()
  await visitor.page.goto(`/u/${student.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 1, name: new RegExp(student.displayName) })).toBeVisible()
  await expect(visitor.page.getByRole('list', { name: '학교 인증' })).toHaveCount(0)
  await page.getByLabel('공개 프로필에 학교 인증 배지 보이기').check()
  await expect(page.getByRole('status').filter({ hasText: '배지를 보입니다' })).toBeVisible()
  await visitor.page.reload()
  await expect(visitor.page.getByRole('list', { name: '학교 인증' })).toContainText(`${pub.schoolName} 인증 · 졸업생`)
  const html = await visitor.page.content()
  const json = await (await visitor.api.raw('GET', `/api/v1/public/profiles/${student.handle}`)).text()
  for (const secret of [department, mailbox.domain, mailbox.email, student.email]) {
    expect(html).not.toContain(secret)
    expect(json).not.toContain(secret)
  }

  // 이 학교 과목 허브에는 쓸 수 있고, 인증하지 않은 다른 학교 과목에는 안내만.
  await page.goto(`/senior-notes?course=${pub.courseId}`)
  await expect(page.getByRole('button', { name: '초안 저장' })).toBeVisible()
  await page.goto(`/senior-notes?course=${other.courseId}`)
  await expect(page.getByText('이 학교 메일로 인증하면 선배 노트를 쓸 수 있습니다.')).toBeVisible()
  await expect(page.getByRole('link', { name: `${other.schoolName} 메일로 인증하기` })).toBeVisible()
  const blocked = await student.api.raw('POST', `/api/v1/courses/${other.courseId}/senior-notes`, {
    displayMode: 'anonymous',
    answers: { firstWeek: '첫 주', timeSink: '배포' },
    noAnswersConfirmed: true,
  })
  expect(blocked.status()).toBe(403)
  expect(await blocked.json()).toMatchObject({ data: { code: 'hub_write_not_allowed', requirement: 'school_affiliation', schoolId: other.schoolId } })
})

test('I-01: P2 기관 플래그가 꺼져 있으면(기본) 기관 인증 진입점이 없고 새 API는 404, 학교 메일 인증 화면은 그대로', async ({ newUser }) => {
  const user = await newUser('p2off')
  const flags = await (await user.api.raw('GET', '/api/v1/features')).json()
  expect(flags).toEqual({ alumni: false, topics: false, institutions: false })
  for (const [method, path, body] of [
    ['GET', '/api/v1/institutions?q=캠프', undefined],
    ['POST', '/api/v1/me/affiliations/invite-code', { code: 'AAAA-BBBB-CCCC', standing: 'student' }],
    ['POST', '/api/v1/me/affiliations/cohort-approval', { institutionId: crypto.randomUUID(), cohortLabel: '1기', standing: 'student' }],
    ['GET', `/api/v1/affiliations/${crypto.randomUUID()}/cohort-approval`, undefined],
    ['GET', '/api/v1/operator/certificate-checks', undefined],
  ] as const) {
    expect((await user.api.raw(method, path, body)).status(), `${method} ${path}`).toBe(404)
  }
  const page = user.page
  await page.goto('/settings/affiliations')
  await expect(page.getByRole('heading', { level: 2, name: '학교 메일로 인증하기' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '부트캠프·교육기관 인증' })).toHaveCount(0)
})
