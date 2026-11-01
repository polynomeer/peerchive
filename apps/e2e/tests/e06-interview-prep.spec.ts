/**
 * E-06 면접 준비 팩(DELIVERY_PLAN §4.4 E-06, ADR 0050). 학생이 케이스 편집 화면에서 인용한 막힘 기록으로 만든 질문에 비공개 답변 메모를 쓰고
 * 그 질문을 공개로 고르면, 로그인하지 않은 검토자가 공개 프로필에서 "이 지원자에게 물어보면 좋은 질문"으로 질문 글만 봅니다.
 * 공개 HTML·공개 JSON·인쇄 보기·README 카드에 답변 메모는 없습니다. 생성 규칙·철회·표시명·탈퇴 정리는 web/worker 통합 테스트가 덮습니다.
 */
import type { InterviewPrepDto, PublicPublicationDto } from '../../web/shared/types/api'
import { featureCaseStudy, rand } from '../support/api'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('E-06: 막힘 기록에서 만든 질문에 비공개 메모를 쓰고 질문만 공개 프로필에 보인다', async ({ newUser, anon }) => {
  const student = await newUser('iprep')
  const pub = await publishCase(student, { stuck: true })
  const { caseStudy } = await featureCaseStudy(student.api, pub.slug)
  const visitor = await anon()
  const stuckKey = (await visitor.api.get<PublicPublicationDto>(`/api/v1/public/publications/${pub.slug}`)).snapshot.logs.find((l) => l.tag === 'stuck')!.key
  const note = `비공개 답변 메모 ${rand()}`

  const { page } = student
  await page.goto(`/portfolio/case-studies/${caseStudy.id}`)
  const pack = page.getByTestId('interview-prep')
  await expect(pack.getByRole('heading', { level: 2, name: '면접 준비 팩' })).toBeVisible()
  const question = pack.locator(`[data-question-key="stuck:${stuckKey}"]`)
  await expect(question).toContainText(pub.stuckSymptom!)
  await question.getByLabel(/내 답변 메모/).fill(note)
  await question.getByRole('button', { name: '메모 저장' }).click()
  await expect(pack.getByRole('status')).toContainText('메모를 저장했습니다')
  await question.getByLabel('공개 프로필에 이 질문 보이기').check()
  await expect(pack.getByRole('status')).toContainText('공개 프로필에 이 질문을 보이기로 했습니다')
  const saved = await student.api.get<InterviewPrepDto>(`/api/v1/case-studies/${caseStudy.id}/interview-prep`)
  const chosen = saved.questions.find((q) => q.key === `stuck:${stuckKey}`)!
  expect(chosen).toMatchObject({ note, shown: true })

  await visitor.page.goto(`/u/${student.handle}`)
  const asked = visitor.page.getByTestId('ask-questions')
  await expect(asked.getByRole('heading', { level: 4, name: '이 지원자에게 물어보면 좋은 질문' })).toBeVisible()
  await expect(asked).toContainText(chosen.text)
  const bodies = [await visitor.page.content()]
  await visitor.page.goto(`/u/${student.handle}/print`)
  await expect(visitor.page.getByText(chosen.text)).toBeVisible()
  bodies.push(await visitor.page.content())
  for (const path of [`/api/v1/public/profiles/${student.handle}`, `/api/v1/public/profiles/${student.handle}/readme-card.md`]) {
    bodies.push(await (await visitor.api.raw('GET', path)).text())
  }
  expect(bodies.join('\n')).not.toContain(note)
  // 다른 사람은 팩 자체를 볼 수 없습니다.
  expect((await visitor.api.raw('GET', `/api/v1/case-studies/${caseStudy.id}/interview-prep`)).status()).toBe(401)
})
