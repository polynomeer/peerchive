/**
 * 시나리오 S. 공개 범위가 공개 절차를 우회하지 않음(DELIVERY_PLAN §5.2, S-03, ADR 0031).
 * 학생이 설정 화면에서 모든 항목을 전체 공개로 바꾸고 과제 두 개를 과제 수행 목록에 올립니다. 비로그인 방문자가 받는 `/u/<handle>`·인쇄 보기의
 * HTML(SSR payload)·공개 JSON·README 카드에는 고른 과제의 과목·학기·제목만 있고, 엠바고 중인 과제의 제목·고르지 않은 비공개 과제·팀원 이름·
 * 로그·동의 대기 공개 후보가 없습니다. 범위를 `로그인 사용자`로 좁히면 비로그인 HTML에서는 빠지고, 로그인한 다른 사용자의 화면에만 브라우저에서
 * 붙습니다.
 */
import type { Page, Response } from '@playwright/test'
import type { MyPersonasDto } from '../../web/shared/types/api'
import { createCandidate, createProject, futureTerm, inviteAndAccept, pastTerm, progressLog, rand } from '../support/api'
import { expect, test } from '../support/fixtures'

async function capture(page: Page, path: string): Promise<string> {
  const bodies: string[] = []
  const pending: Promise<void>[] = []
  const onResponse = (res: Response) => {
    const type = res.request().resourceType()
    if (type === 'document' || type === 'fetch' || type === 'xhr') pending.push(res.text().then((t) => void bodies.push(t), () => undefined))
  }
  page.on('response', onResponse)
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  bodies.push(await page.content())
  await Promise.all(pending)
  page.off('response', onResponse)
  return bodies.join('\n')
}

test('S: 전체 공개여도 과제 수행 목록은 고른 과제의 과목·학기·제목뿐, 엠바고 제목·비공개 과제·팀원·후보는 없다', async ({ newUser, anon }) => {
  const student = await newUser('sora')
  const mate = await newUser('mate')
  const past = await pastTerm(student.api)
  const future = await futureTerm(student.api)
  const team = await createProject(student.api, { title: `팀 과제 ${rand()}`, kind: 'team', courseTermId: past.termId })
  await inviteAndAccept(student.api, mate.api, team.id)
  const logBody = `비공개 로그 LOG${rand()}`
  const log = await progressLog(mate.api, team.id, logBody)
  const embargoedTitle = `엠바고 과제 EMB${rand()}`
  const embargoed = await createProject(student.api, { title: embargoedTitle, courseTermId: future.termId })
  const privateTitle = `비공개 과제 PRV${rand()}`
  await createProject(student.api, { title: privateTitle })
  const candidateTitle = `동의 대기 CAND${rand()}`
  await createCandidate(student.api, team.id, { level: 'summary', title: candidateTitle, logIds: [log.id], exposure: { [student.id]: 'name', [mate.id]: 'name' } })

  // 설정 화면: 모든 항목 전체 공개 + 두 과제 올리기
  const page = student.page
  await page.goto('/settings/visibility')
  for (const label of ['과제 수행 목록', '공개 글', '선배 노트·스터디 기록', '팔로워·팔로잉 목록']) await page.getByRole('combobox', { name: label, exact: true }).selectOption('public')
  await page.getByRole('button', { name: '저장' }).click()
  await expect(page.getByRole('status').filter({ hasText: '공개 범위를 저장했습니다' })).toBeVisible()
  await page.getByRole('checkbox', { name: team.title }).check()
  await expect(page.getByRole('status').filter({ hasText: '목록에 올렸습니다' })).toBeVisible()
  await page.getByRole('checkbox', { name: embargoedTitle }).check()
  await expect(page.getByRole('status').filter({ hasText: `"${embargoedTitle}"을(를) 목록에 올렸습니다` })).toBeVisible()
  await expect(page.getByText('엠바고 중이라 공개 프로필에는 제목 없이 과목·학기만 보입니다.')).toBeVisible()

  const visitor = await anon()
  const everything = async () => {
    const parts = [await capture(visitor.page, `/u/${student.handle}`), await capture(visitor.page, `/u/${student.handle}/print`)]
    for (const path of [`/api/v1/public/profiles/${student.handle}`, `/api/v1/public/profiles/${student.handle}/readme-card.md`, `/api/v1/profiles/${student.handle}`]) {
      const res = await visitor.api.raw('GET', path)
      expect(res.status(), path).toBe(200)
      parts.push(await res.text())
    }
    return parts.join('\n')
  }
  const body = await everything()
  expect(body).toContain(team.title)
  expect(body).toContain(past.courseTitle)
  expect(body).toContain(future.courseTitle)
  for (const secret of [embargoedTitle, embargoed.id, privateTitle, mate.displayName, mate.handle, mate.id, logBody, log.id, candidateTitle, team.id])
    expect(body, secret.slice(0, 8)).not.toContain(secret)
  await visitor.page.goto(`/u/${student.handle}`)
  const section = visitor.page.getByRole('region', { name: '과제 수행 목록' })
  await expect(section.getByText(team.title)).toBeVisible()
  await expect(section.getByText('제목 비공개 기간(엠바고)')).toBeVisible()

  // 로그인 사용자로 좁히기 → 비로그인 HTML·JSON에서 빠지고, 로그인한 다른 사용자 화면에는 브라우저에서 붙음
  await page.getByRole('combobox', { name: '과제 수행 목록', exact: true }).selectOption('signed_in')
  await page.getByRole('button', { name: '저장' }).click()
  await expect(page.getByRole('status').filter({ hasText: '공개 범위를 저장했습니다' })).toBeVisible()
  const narrowed = await everything()
  expect(narrowed).not.toContain(team.title)
  await visitor.page.goto(`/u/${student.handle}`)
  await expect(visitor.page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(visitor.page.getByRole('region', { name: '과제 수행 목록' })).toHaveCount(0)
  await mate.page.goto(`/u/${student.handle}`)
  await expect(mate.page.getByRole('region', { name: '과제 수행 목록' }).getByText(team.title)).toBeVisible()

  // 과제 공간 읽기 권한은 그대로: 방문자·다른 사용자 모두 404, 팀원은 그대로 열람
  const other = await newUser('other')
  expect((await other.api.raw('GET', `/api/v1/projects/${team.id}`)).status()).toBe(404)
  expect((await visitor.api.raw('GET', `/api/v1/projects/${team.id}`)).status()).toBe(401)
  expect((await mate.api.raw('GET', `/api/v1/projects/${team.id}`)).status()).toBe(200)

  // 남의 페르소나 공개 범위는 404, 공개 사례 항목은 422
  const mine = await student.api.get<MyPersonasDto>('/api/v1/me/personas')
  const realId = mine.personas.find((p) => p.kind === 'real')!.id
  expect((await other.api.raw('PUT', `/api/v1/personas/${realId}/visibility`, { items: { posts: 'public' } })).status()).toBe(404)
  expect((await student.api.raw('PUT', `/api/v1/personas/${realId}/visibility`, { items: { case_studies: 'public' } })).status()).toBe(422)
})
