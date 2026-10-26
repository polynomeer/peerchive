/**
 * 시나리오 F. 후배의 과목 탐색과 플랜 포크(DELIVERY_PLAN §5, T-13).
 * 비로그인 방문자가 과목 페이지에서 공개 사례·막힘·선배 노트를 봅니다. 통계 동의자가 5명 미만이면 워크로드 분포는 나오지 않습니다.
 * 로그인한 후배가 포크하면 마일스톤만 있는 새 비공개 과제가 생기고 로그·파일·막힘 해결 내용은 복사되지 않습니다.
 * 선배 노트는 그 학교 메일로 인증한 계정만 씁니다(C-01): 선배는 노트 화면의 안내를 따라 화면에서 학교 메일을 인증한 뒤 씁니다.
 * 후배의 포크(읽기·계획 복사)에는 인증이 필요 없습니다.
 */
import type { ArtifactDto, LogPageDto, MilestoneDto, ProjectDetailDto } from '../../web/shared/types/api'
import { rand } from '../support/api'
import { requestAndVerify, schoolMailbox } from '../support/affiliation'
import { expect, test } from '../support/fixtures'
import { publishCase } from '../support/scenarios'

test('F: 익명 과목 허브(사례·막힘·선배 노트, 워크로드 숨김) → 후배 포크는 계획만', async ({ newUser, anon }) => {
  const senior = await newUser('sena')
  const milestones = [`기획 ${rand(2)}`, `중간발표 ${rand(2)}`, `최종제출 ${rand(2)}`]
  const pub = await publishCase(senior, { stuck: true, withPdf: true, milestones })

  // 선배 노트를 쓰려면 그 학교 메일 인증이 필요합니다: 노트 화면 → 안내 링크 → 학교가 미리 골라진 인증 화면 → 코드 입력 → 돌아가기.
  const mailbox = schoolMailbox(pub.schoolId)
  await senior.page.goto(`/senior-notes?course=${pub.courseId}`)
  await expect(senior.page.getByText('이 학교 메일로 인증하면 선배 노트를 쓸 수 있습니다.')).toBeVisible()
  await expect(senior.page.getByRole('button', { name: '초안 저장' })).toHaveCount(0)
  await senior.page.getByRole('link', { name: `${pub.schoolName} 메일로 인증하기` }).click()
  await senior.page.waitForURL(/\/settings\/affiliations\?/)
  await requestAndVerify(senior.page, mailbox.email)
  await senior.page.getByRole('link', { name: '선배 노트 쓰러 돌아가기' }).click()
  await senior.page.waitForURL(new RegExp(`/senior-notes\\?course=${pub.courseId}$`))
  await expect(senior.page.getByRole('button', { name: '초안 저장' })).toBeVisible()

  // 선배 노트(준비 단계라 API)
  const noteAnswer = `첫 주에 ERD부터 합의하세요 ${rand()}`
  const note = await senior.api.post<{ id: string; version: number }>(`/api/v1/courses/${pub.courseId}/senior-notes`, {
    displayMode: 'anonymous',
    answers: { firstWeek: noteAnswer, timeSink: '배포 환경 맞추기에 시간이 오래 걸렸습니다.' },
    noAnswersConfirmed: true,
  })
  await senior.api.post(`/api/v1/senior-notes/${note.id}/publish`, { expectedVersion: note.version, confirmWarnings: true })

  // 익명 방문자
  const visitor = await anon()
  const res = await visitor.page.goto(`/c/${pub.courseId}`)
  expect(res?.status()).toBe(200)
  const hub = visitor.page
  await expect(hub.getByRole('heading', { level: 1, name: new RegExp(pub.courseTitle) })).toBeVisible()
  const cases = hub.getByRole('region', { name: '공개 사례' })
  await expect(cases.getByRole('link', { name: pub.title })).toBeVisible()
  const stuck = hub.getByRole('region', { name: '자주 막히는 지점' })
  await expect(stuck.getByRole('link', { name: pub.stuckSymptom! })).toBeVisible()
  const notes = hub.getByRole('region', { name: '선배 노트' })
  await expect(notes.getByText(noteAnswer)).toBeVisible()
  const workload = hub.getByRole('region', { name: '체감 소요 시간·난이도' })
  await expect(workload.getByRole('table')).toHaveCount(0)
  await expect(workload).toContainText('5명 이상이면 보여 줍니다')

  // 공개 사례로 이동: 비로그인이면 포크 버튼 대신 로그인 안내
  await cases.getByRole('link', { name: pub.title }).click()
  await expect(hub).toHaveURL(new RegExp(`/p/${pub.slug}$`))
  await expect(hub.getByRole('region', { name: '이 계획으로 시작하기' })).toContainText('로그인')
  await expect(hub.getByRole('button', { name: '이 계획 포크하기' })).toHaveCount(0)

  // 로그인한 후배: 포크
  const junior = await newUser('jun')
  await junior.page.goto(`/p/${pub.slug}`)
  await junior.page.getByRole('button', { name: '이 계획 포크하기' }).click()
  await junior.page.waitForURL(/\/projects\/[0-9a-f-]{36}$/)
  const forkId = new URL(junior.page.url()).pathname.split('/').pop()!
  expect(forkId).not.toBe(pub.projectId)
  await expect(junior.page.getByText('🔒 팀만 보기').first()).toBeVisible()
  const msList = junior.page.getByRole('list', { name: '마일스톤 (순서대로)' })
  for (const title of milestones) await expect(msList.getByText(title)).toBeVisible()
  await expect(junior.page.getByRole('list', { name: '로그 목록 (최신순)' }).getByRole('listitem')).toHaveCount(0)
  await expect(junior.page.getByText('아직 산출물이 없습니다.')).toBeVisible()

  // API로도: 마일스톤만, 로그·파일 없음, 원본 문장 없음
  const project = await junior.api.get<ProjectDetailDto>(`/api/v1/projects/${forkId}`)
  expect(project.myRole).toBe('owner')
  const ms = await junior.api.get<MilestoneDto[]>(`/api/v1/projects/${forkId}/milestones`)
  expect(ms.map((m) => m.title)).toEqual(milestones)
  expect((await junior.api.get<LogPageDto>(`/api/v1/projects/${forkId}/logs`)).items).toEqual([])
  expect(await junior.api.get<ArtifactDto[]>(`/api/v1/projects/${forkId}/artifacts`)).toEqual([])
  const dump = JSON.stringify({ project, ms })
  expect(dump).not.toContain(pub.progressText)
  expect(dump).not.toContain(pub.stuckSymptom!)
  // 원본은 그대로 senior만 볼 수 있음
  expect((await junior.api.raw('GET', `/api/v1/projects/${pub.projectId}`)).status()).toBe(404)
})
