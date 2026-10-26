/**
 * 여러 시나리오가 함께 쓰는 준비 단계: "이미 끝난 학기 과목에 연결해 게시한 사례".
 * 시험 대상이 아닌 부분이라 API로 빠르게 만듭니다(게시 흐름 자체는 시나리오 D가 화면으로 확인).
 */
import type { PublicationCandidateDto, PublishResultDto } from '../../web/shared/types/api'
import {
  addClaim,
  addMilestone,
  createCandidate,
  createProject,
  pastTerm,
  progressLog,
  publish,
  rand,
  stuckLog,
  uploadPdf,
  waitForClean,
} from './api'
import type { E2eUser } from './fixtures'

export interface PublishedCase {
  projectId: string
  slug: string
  title: string
  courseId: string
  courseTitle: string
  progressText: string
  stuckSymptom: string | null
  claimText: string
  milestoneTitles: string[]
  pdf: { artifactId: string; versionId: string; fileName: string } | null
  candidate: PublicationCandidateDto
  result: PublishResultDto
}

export async function publishCase(
  owner: E2eUser,
  options: { withPdf?: boolean; stuck?: boolean; milestones?: string[]; retroMode?: boolean; showName?: boolean } = {},
): Promise<PublishedCase> {
  const api = owner.api
  const term = await pastTerm(api)
  const project = await createProject(api, { title: `게시 과제 ${rand()}`, courseTermId: term.termId, retroMode: options.retroMode ?? false })
  const progressText = `세션 저장소를 Redis로 바꿈 ${rand()}`
  const progress = await progressLog(api, project.id, progressText)
  const stuckSymptom = options.stuck ? `배포 후 CORS 에러 ${rand()}` : null
  const stuck = stuckSymptom ? await stuckLog(api, project.id, stuckSymptom) : null
  const milestoneTitles = options.milestones ?? []
  const milestoneIds: string[] = []
  for (const title of milestoneTitles) milestoneIds.push((await addMilestone(api, project.id, title)).id)
  let pdf: PublishedCase['pdf'] = null
  if (options.withPdf) {
    const fileName = `final-${rand()}.pdf`
    const uploaded = await uploadPdf(api, project.id, fileName)
    await waitForClean(api, uploaded.artifactId)
    pdf = { ...uploaded, fileName }
  }
  const claimText = `세션·인증 백엔드를 맡았다 ${rand()}`
  const claim = await addClaim(api, project.id, claimText, [{ kind: 'log', id: progress.id }])
  const title = `공개 사례 ${rand()}`
  const candidate = await createCandidate(api, project.id, {
    level: 'full',
    title,
    logIds: [progress.id, ...(stuck ? [stuck.id] : [])],
    milestoneIds,
    claimIds: [claim.id],
    artifactVersionIds: pdf ? [pdf.versionId] : [],
    exposure: { [owner.id]: options.showName === false ? 'anonymous' : 'name' },
    consentSelf: true,
  })
  const result = await publish(api, candidate)
  return {
    projectId: project.id,
    slug: candidate.slug,
    title,
    courseId: term.courseId,
    courseTitle: term.courseTitle,
    progressText,
    stuckSymptom,
    claimText,
    milestoneTitles,
    pdf,
    candidate,
    result,
  }
}
