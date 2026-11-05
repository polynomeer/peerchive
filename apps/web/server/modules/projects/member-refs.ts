/**
 * 과제 응답의 멤버 참조(ADR 0026 부록 — 익명 스터디 기록의 사용자 id 가명화, ADR 0060 — 표시명 스터디 기록도 같은 규칙).
 *
 * 표시명 스터디 방의 기록도 아래 규칙을 그대로 따릅니다. 다른 점은 이름뿐입니다: 다른 멤버는 표시명 페르소나 이름으로, 표시명이 없으면 "스터디 멤버 N"으로 보입니다.
 * 방별 이름(A-01)은 커뮤니티 테이블이라 과제 모듈에서 읽지 않습니다.
 *
 * 익명 스터디 방의 기록(kind study + study_name_mode anonymous)에서는 다른 멤버의 이름뿐 아니라 **사용자 id도** 응답에 싣지 않습니다.
 * 같은 사람과 다른(익명이 아닌) 과제·방·팀을 함께 쓰는 멤버가 그쪽 응답의 id와 맞춰 보면 "스터디 멤버 N"이 누구인지 알 수 있기 때문입니다.
 *
 * - 출력: 다른 사람의 id는 `sm_` + HMAC-SHA256(PEERCHIVE_MEMBER_REF_PEPPER, `study-member-ref:v1:<과제 id>:<사용자 id>`) 앞 16자.
 *   과제마다 다르고(다른 과제의 키와 이어지지 않음) 보는 사람과 무관하며(같은 과제의 멤버는 같은 키를 봄) 저장하지 않습니다.
 *   본인 id는 그대로 둡니다(화면의 "나" 표시·내 선언·내 동의 판정이 `me.id`와 비교).
 * - 이름: 본인은 그대로, 다른 사람은 "스터디 멤버 N". 번호는 **가명 키 순서**입니다(가입 순서가 아님 — 방 멤버 목록의 가입 순서와 맞춰
 *   번호를 사람에게 잇지 못하게). 멤버가 들고 나면 번호가 바뀔 수 있습니다.
 * - 입력: 멤버를 가리키는 입력(할 일 담당자, 회의 참석자, 공개 노출 방식, 로그 작성자 필터)은 이 키(또는 본인 id)를 받아
 *   서버에서 실제 id로 바꿉니다. 모르는 키·다른 사람의 실제 id는 422(`not_member`)입니다.
 * - 실명 방의 기록과 일반 과제는 모든 함수가 그대로 돌려줍니다(입력도 기존 검사 그대로).
 *
 * DB에는 실제 id가 그대로 남습니다(회의 참석자 payload 포함). 바뀌는 것은 API 응답과 그 입력뿐입니다.
 * 과제 서비스는 DTO를 만들 때 이 모듈의 `loadMemberRefs` 하나만 씁니다(문자열 치환 없음).
 */
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { isProductionMode, MEMBER_REF_PEPPER_ENV, resolvePepper } from '@peerchive/db'
import { studyMemberLabels } from '@peerchive/domain'
import { and, eq, inArray, personas, projectMembers, projects, type DbExecutor } from '@peerchive/db'
import { invalid } from '../errors'
import type { ProjectRow } from './access'

// ── 설정 ─────────────────────────────────────────────────────────────────

type Env = Readonly<Record<string, string | undefined>>

let envOverride: Env | null = null
/** 테스트용: 환경 변수 대신 쓸 값(null이면 process.env). */
export function setMemberRefEnvForTesting(env: Env | null): void {
  envOverride = env
}

function currentEnv(): Env {
  if (envOverride) return envOverride
  const env = (globalThis.process?.env ?? {}) as Env
  return { NODE_ENV: env['NODE_ENV'], [MEMBER_REF_PEPPER_ENV]: env[MEMBER_REF_PEPPER_ENV] }
}

/** 시작 확인(server/plugins/member-refs.ts): production에서 pepper가 없거나 약하면 문제 목록. */
export function memberRefConfigProblems(env: Env = currentEnv()): string[] {
  if (!isProductionMode(env)) return []
  return resolvePepper(env, MEMBER_REF_PEPPER_ENV)
    ? []
    : [`${MEMBER_REF_PEPPER_ENV} is missing or weak (production requires a random secret of 32+ characters, e.g. openssl rand -hex 32)`]
}

export function memberRefPepper(): string {
  const pepper = resolvePepper(currentEnv(), MEMBER_REF_PEPPER_ENV)
  if (!pepper) throw new Error(`${MEMBER_REF_PEPPER_ENV} is not configured`)
  return pepper
}

// ── 키 ───────────────────────────────────────────────────────────────────

export const MEMBER_REF_PATTERN = /^sm_[0-9a-f]{16}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 과제 안의 멤버 가명 키. 사용자 id(uuid)와 모양이 달라 다른 어떤 id와도 같을 수 없습니다. */
export function memberRefKey(pepper: string, projectId: string, userId: string): string {
  const digest = createHmac('sha256', pepper).update(`study-member-ref:v1:${projectId.toLowerCase()}:${userId.toLowerCase()}`).digest('hex')
  return `sm_${digest.slice(0, 16)}`
}

/** 멤버를 가리키는 입력 값: 사용자 id(uuid) 또는 가명 키. 소문자로 바꿉니다. 실제 사람으로 바꾸는 것은 `MemberRefs.resolve`. */
export const memberRefSchema = z
  .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
  .trim()
  .toLowerCase()
  .refine((value) => UUID_PATTERN.test(value) || MEMBER_REF_PATTERN.test(value), { error: 'invalid' })

// ── 응답·입력 변환 ────────────────────────────────────────────────────────

export interface PersonRef {
  userId: string
  displayName: string
  handle: string | null
}

export interface MemberRefs {
  /** 익명 스터디 기록이라 다른 사람의 id·이름을 바꾸는지. */
  readonly pseudonymous: boolean
  /** 응답에 실을 사용자 참조(본인·익명이 아닌 과제는 id 그대로). */
  ref(userId: string): string
  refOrNull(userId: string | null): string | null
  /** 이름만 가립니다(id는 실제 값 유지 — 서버 안의 정렬·집계용). 응답에는 `person`을 씁니다. */
  maskName<T extends PersonRef>(person: T): T
  /** 응답용 사람 표시: 이름을 가리고 id를 참조로 바꿉니다. */
  person<T extends PersonRef>(person: T): T
  /**
   * 입력 참조 → 실제 사용자 id. 익명 스터디 기록에서는 본인 id 또는 이 과제 멤버(어느 상태든)의 가명 키만 받고, 그 밖에는 null.
   * 익명이 아닌 과제는 uuid면 그대로(멤버인지는 호출자의 기존 검사가 봄), 가명 키는 null.
   */
  resolve(ref: string): string | null
  /** 여러 참조를 바꿉니다. 하나라도 모르면 422 `{[field]: 'not_member'}`. */
  resolveAll(refs: readonly string[], field: string): string[]
}

type ProjectKey = Pick<ProjectRow, 'id' | 'kind' | 'studyNameMode'>

/** 익명 스터디 방의 기록인지(과제 행에 옮겨 둔 방 이름 표시 방식). */
export const isAnonymousStudyProject = (project: Pick<ProjectRow, 'kind' | 'studyNameMode'>): boolean =>
  project.kind === 'study' && project.studyNameMode === 'anonymous'

/** 다른 멤버의 이름과 사용자 id를 가리는 기록인지. 실명 방의 기록만 그대로 보입니다(ADR 0060). */
const isPseudonymousStudyProject = (project: Pick<ProjectRow, 'kind' | 'studyNameMode'>): boolean =>
  project.kind === 'study' && project.studyNameMode !== 'real'

function strictResolveAll(resolve: (ref: string) => string | null) {
  return (refs: readonly string[], field: string): string[] => {
    const out: string[] = []
    for (const ref of refs) {
      const id = resolve(ref)
      if (!id) throw invalid({ [field]: 'not_member' })
      out.push(id)
    }
    return out
  }
}

const passthroughResolve = (ref: string): string | null => {
  const value = ref.trim().toLowerCase()
  return UUID_PATTERN.test(value) ? value : null
}

const PASSTHROUGH: MemberRefs = {
  pseudonymous: false,
  ref: (userId) => userId,
  refOrNull: (userId) => userId,
  maskName: (person) => person,
  person: (person) => person,
  resolve: passthroughResolve,
  resolveAll: strictResolveAll(passthroughResolve),
}

/**
 * 과제의 멤버 참조 변환을 읽습니다. 익명 스터디 기록이 아니면 아무것도 읽지 않습니다.
 * `project`는 과제 행 또는 과제 id(행을 한 번 읽음).
 */
export async function loadMemberRefs(db: DbExecutor, project: ProjectKey | string, viewerId: string): Promise<MemberRefs> {
  let row: ProjectKey | undefined
  if (typeof project === 'string') {
    ;[row] = await db
      .select({ id: projects.id, kind: projects.kind, studyNameMode: projects.studyNameMode })
      .from(projects)
      .where(eq(projects.id, project))
      .limit(1)
  } else row = project
  if (!row || !isPseudonymousStudyProject(row)) return PASSTHROUGH
  const projectId = row.id
  const pepper = memberRefPepper()
  const viewer = viewerId.toLowerCase()
  const members = await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, projectId))
  const keyOf = new Map<string, string>()
  const key = (userId: string) => {
    const id = userId.toLowerCase()
    let k = keyOf.get(id)
    if (!k) {
      k = memberRefKey(pepper, projectId, id)
      keyOf.set(id, k)
    }
    return k
  }
  const byKey = new Map(members.map((m) => [key(m.userId), m.userId.toLowerCase()]))
  // 번호는 가명 키 순서(가입 순서와 이어지지 않게).
  const label = studyMemberLabels(members.map((m) => m.userId.toLowerCase()).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)))
  // 표시명 기록: 지금 active인 표시명 페르소나 이름(없으면 위 번호 이름). 익명 기록은 읽지 않습니다.
  const memberIds = members.map((m) => m.userId)
  const penNames = new Map(
    !isAnonymousStudyProject(row) && memberIds.length
      ? (
          await db
            .select({ userId: personas.userId, displayName: personas.displayName })
            .from(personas)
            .where(and(inArray(personas.userId, memberIds), eq(personas.kind, 'display'), eq(personas.status, 'active')))
        ).map((p) => [p.userId.toLowerCase(), p.displayName] as const)
      : [],
  )
  const isViewer = (userId: string) => userId.toLowerCase() === viewer
  const ref = (userId: string) => (isViewer(userId) ? userId : key(userId))
  const maskName = <T extends PersonRef>(person: T): T =>
    isViewer(person.userId) ? person : { ...person, displayName: penNames.get(person.userId.toLowerCase()) ?? label(person.userId.toLowerCase()), handle: null }
  const resolve = (input: string): string | null => {
    const value = input.trim().toLowerCase()
    if (value === viewer) return viewerId
    return MEMBER_REF_PATTERN.test(value) ? (byKey.get(value) ?? null) : null
  }
  return {
    pseudonymous: true,
    ref,
    refOrNull: (userId) => (userId === null ? null : ref(userId)),
    maskName,
    person: <T extends PersonRef>(person: T): T => {
      const masked = maskName(person)
      return { ...masked, userId: ref(person.userId) }
    },
    resolve,
    resolveAll: strictResolveAll(resolve),
  }
}
