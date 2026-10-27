/**
 * 브라우저 context의 요청 객체(쿠키 공유)로 부르는 API 도우미. 시험 대상이 아닌 준비 단계에만 씁니다.
 * 상태를 바꾸는 요청에는 CSRF 검사(ADR 0006)를 통과하도록 사이트 Origin을 붙입니다.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import type {
  ArtifactDto,
  CaseStudyDto,
  ClaimDto,
  LogDto,
  MyPersonaDto,
  PortfolioEditionDto,
  ProjectDetailDto,
  ProjectDto,
  PublicationCandidateDto,
  PublishResultDto,
  UploadCompleteDto,
  UploadIntentDto,
} from '../../web/shared/types/api'
import { SITE_ORIGIN } from './env'

export const rand = (bytes = 4) => randomBytes(bytes).toString('hex')

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export class Api {
  constructor(readonly request: APIRequestContext) {}

  async raw(method: Method, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<APIResponse> {
    return this.request.fetch(path, {
      method,
      ...(data !== undefined && { data }),
      headers: { ...(method === 'GET' ? {} : { Origin: SITE_ORIGIN }), ...headers },
      failOnStatusCode: false,
    })
  }

  async call<T>(method: Method, path: string, data?: unknown): Promise<T> {
    const res = await this.raw(method, path, data)
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }

  get = <T>(path: string) => this.call<T>('GET', path)
  post = <T>(path: string, data?: unknown) => this.call<T>('POST', path, data ?? {})
  patch = <T>(path: string, data: unknown) => this.call<T>('PATCH', path, data)
}

// ── 페르소나 ───────────────────────────────────────────────────────────────

/** 표시명 프로필(S-01)을 API로 만듭니다. 커뮤니티 표시명 방식으로 쓰려면 이것이 있어야 합니다(ADR 0030). */
export async function createDisplayPersona(api: Api, label = 'disp'): Promise<{ id: string; handle: string; displayName: string }> {
  const handle = `${label}-${rand(4)}`.slice(0, 30)
  const displayName = `표시명${label}${rand(2)}`
  const created = await api.post<MyPersonaDto>('/api/v1/personas', { handle, displayName })
  return { id: created.id, handle, displayName }
}

// ── 과제·멤버 ─────────────────────────────────────────────────────────────

export function createProject(
  api: Api,
  input: { title?: string; kind?: 'individual' | 'team'; retroMode?: boolean; courseTermId?: string | null } = {},
): Promise<ProjectDto> {
  return api.post<ProjectDto>('/api/v1/projects', {
    title: input.title ?? `E2E 과제 ${rand()}`,
    kind: input.kind ?? 'individual',
    retroMode: input.retroMode ?? false,
    courseTermId: input.courseTermId ?? null,
  })
}

export async function setCourseTerm(api: Api, projectId: string, courseTermId: string): Promise<ProjectDetailDto> {
  const project = await api.get<ProjectDetailDto>(`/api/v1/projects/${projectId}`)
  return api.patch<ProjectDetailDto>(`/api/v1/projects/${projectId}`, { expectedVersion: project.version, courseTermId })
}

/** owner가 초대 링크를 만들고 member가 수락합니다. */
export async function inviteAndAccept(owner: Api, member: Api, projectId: string, role: 'editor' | 'reviewer' | 'viewer' = 'editor'): Promise<void> {
  const { inviteUrl } = await owner.post<{ inviteUrl: string }>(`/api/v1/projects/${projectId}/invitations`, { role })
  const token = new URL(inviteUrl).pathname.split('/').pop()
  await member.post('/api/v1/invitations/accept', { token })
}

// ── 기록 ─────────────────────────────────────────────────────────────────

export function addLog(api: Api, projectId: string, input: Record<string, unknown>): Promise<LogDto> {
  return api.post<LogDto>(`/api/v1/projects/${projectId}/logs`, { clientId: randomUUID(), ...input })
}

export const progressLog = (api: Api, projectId: string, body: string) => addLog(api, projectId, { tag: 'progress', body })

export const stuckLog = (api: Api, projectId: string, symptom: string) =>
  addLog(api, projectId, { tag: 'stuck', payload: { symptom, timeBucket: 'lt30m', keywords: ['e2e'] } })

export function addClaim(api: Api, projectId: string, text: string, evidence: Array<{ kind: 'log' | 'artifact'; id: string }> = []): Promise<ClaimDto> {
  return api.post<ClaimDto>(`/api/v1/projects/${projectId}/claims`, { text, evidence })
}

export function addMilestone(api: Api, projectId: string, title: string) {
  return api.post<{ id: string; title: string }>(`/api/v1/projects/${projectId}/milestones`, { title })
}

export function addTask(api: Api, projectId: string, title: string) {
  return api.post<{ id: string; title: string }>(`/api/v1/projects/${projectId}/tasks`, { title })
}

// ── 파일 ─────────────────────────────────────────────────────────────────

/** 실제 PDF 리더가 여는 최소 PDF. 같은 과제의 같은 내용은 하나로 합쳐지므로 주석 한 줄로 내용을 다르게 합니다. */
export function pdfBytes(): Buffer {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj',
      'trailer<</Root 1 0 R>>',
      `% e2e ${rand(8)}`,
      '%%EOF',
    ].join('\n'),
    'latin1',
  )
}

export async function uploadPdf(api: Api, projectId: string, fileName = `report-${rand()}.pdf`): Promise<{ artifactId: string; versionId: string }> {
  const body = pdfBytes()
  const intent = await api.post<UploadIntentDto>(`/api/v1/projects/${projectId}/artifacts/upload-intents`, {
    fileName,
    declaredType: 'application/pdf',
    byteSize: body.length,
    clientId: randomUUID(),
  })
  const put = await api.raw('PUT', intent.uploadUrl, body, { 'content-type': 'application/pdf' })
  expect(put.ok(), `PUT upload → ${put.status()}`).toBeTruthy()
  const done = await api.post<UploadCompleteDto>(intent.completeUrl)
  return { artifactId: done.artifact.id, versionId: done.version.id }
}

/** worker가 검사를 끝낼 때까지 기다립니다(signature-only 검사기). */
export async function waitForClean(api: Api, artifactId: string): Promise<void> {
  await expect
    .poll(async () => (await api.get<ArtifactDto>(`/api/v1/artifacts/${artifactId}`)).latestVersion?.scanStatus, {
      timeout: 30_000,
      message: '파일 검사가 clean이 되기를 기다림',
    })
    .toBe('clean')
}

// ── 학교·과목·학기 ───────────────────────────────────────────────────────

export async function courseTerm(
  api: Api,
  term: { year: number; semester: 'spring' | 'summer' | 'fall' | 'winter' },
): Promise<{ schoolId: string; schoolName: string; courseId: string; termId: string; courseTitle: string }> {
  const school = await api.post<{ id: string; name: string }>('/api/v1/schools', { name: `E2E대학교 ${rand()}`, confirmNew: true })
  const courseTitle = `E2E 과목 ${rand()}`
  const course = await api.post<{ id: string }>(`/api/v1/schools/${school.id}/courses`, { title: courseTitle, confirmNew: true })
  const created = await api.post<{ term: { id: string } }>(`/api/v1/courses/${course.id}/terms`, term)
  return { schoolId: school.id, schoolName: school.name, courseId: course.id, termId: created.term.id, courseTitle }
}

/** 이미 끝난 학기(엠바고 없음). */
export const pastTerm = (api: Api) => courseTerm(api, { year: new Date().getFullYear() - 1, semester: 'spring' })
/** 아직 끝나지 않은 학기(내년 봄 → 학기 종료 엠바고). */
export const futureTerm = (api: Api) => courseTerm(api, { year: new Date().getFullYear() + 1, semester: 'spring' })

// ── 공개 ─────────────────────────────────────────────────────────────────

export interface CandidateInput {
  level?: 'summary' | 'full'
  title?: string
  summary?: string
  slug?: string
  logIds?: string[]
  milestoneIds?: string[]
  claimIds?: string[]
  artifactVersionIds?: string[]
  exposure?: Record<string, 'name' | 'anonymous'>
  consentSelf?: boolean
}

export function createCandidate(api: Api, projectId: string, input: CandidateInput = {}): Promise<PublicationCandidateDto> {
  return api.post<PublicationCandidateDto>(`/api/v1/projects/${projectId}/publication-candidates`, {
    level: input.level ?? 'full',
    title: input.title ?? `공개 사례 ${rand()}`,
    summary: input.summary ?? 'E2E 시험용 학생 요약입니다.',
    slug: input.slug ?? `e2e-${rand(6)}`,
    logIds: input.logIds ?? [],
    milestoneIds: input.milestoneIds ?? [],
    claimIds: input.claimIds ?? [],
    artifactVersionIds: input.artifactVersionIds ?? [],
    exposure: input.exposure ?? {},
    consentSelf: input.consentSelf ?? true,
  })
}

export function consent(api: Api, candidate: Pick<PublicationCandidateDto, 'id' | 'manifestHash'>): Promise<PublicationCandidateDto> {
  return api.post<PublicationCandidateDto>(`/api/v1/candidates/${candidate.id}/consents`, {
    decision: 'granted',
    manifestHash: candidate.manifestHash,
  })
}

export function publish(api: Api, candidate: Pick<PublicationCandidateDto, 'id' | 'manifestHash'>): Promise<PublishResultDto> {
  return api.post<PublishResultDto>(`/api/v1/candidates/${candidate.id}/publish`, { manifestHash: candidate.manifestHash })
}

// ── 케이스 스터디·포트폴리오 ─────────────────────────────────────────────

export async function featureCaseStudy(api: Api, slug: string, jobTarget = 'backend'): Promise<{ caseStudy: CaseStudyDto; edition: PortfolioEditionDto }> {
  const draft = await api.post<CaseStudyDto>('/api/v1/case-studies', { releaseSlug: slug, jobTarget, revealSelf: true })
  await api.post(`/api/v1/case-studies/${draft.id}/publish`, { expectedVersion: draft.version, confirmWarnings: true })
  const edition = await api.post<PortfolioEditionDto>('/api/v1/portfolio-editions', { featuredCaseStudyIds: [draft.id] })
  return { caseStudy: draft, edition }
}
