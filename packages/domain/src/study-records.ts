/**
 * 스터디 기록 규칙 (C-08, PROOFU_EVOLUTION_PLAN §8.9.5·§8.9.8, SYSTEM_DESIGN §6.7 StudyRecord, DELIVERY_PLAN §4.1 C-08, ADR 0026).
 *
 * - 스터디 방이 기록을 켜면 내부 과제 공간(kind = study)이 생기고, 그 과제의 멤버십은 **방 멤버십에서 파생**됩니다.
 *   원천은 방 멤버십 하나뿐이고, 과제 멤버십은 방 멤버십을 바꾸는 같은 트랜잭션에서 `planStudyRecordSync`로 다시 계산해 씁니다.
 * - 역할 대응: 방장(owner) → 과제 owner(공개 준비·게시 담당), 그 밖의 active 멤버(admin·moderator·member) → editor(로그·마일스톤·할 일·파일).
 *   방이 보관·제한되면(active가 아님) owner를 뺀 모두가 viewer(읽기만)가 됩니다. 승인 대기(pending)는 과제 멤버가 아닙니다.
 *   방을 떠난 사람은 left, 내보내진·거절된 사람은 removed(기록은 남음, 팀 과제와 같음).
 * - 익명 스터디 방(anonymous): 기록 안에서 다른 멤버의 이름을 "스터디 멤버 N"으로 보이고(본인은 자기 이름), 공개 후보는 모든 사람을 익명으로만
 *   만들 수 있으며(이름 노출 422), 그 release로는 케이스 스터디(포트폴리오)를 만들 수 없고(422 `anonymous_study`) 공개 프로필·모집 첨부에도 나오지 않습니다.
 *   판정은 **공개 후보를 만들 때 스냅샷에 고정한 방식**(`studyNameMode`)으로 합니다. 방 방식이 나중에 바뀌어도 이미 만든 후보·release는 그대로입니다.
 */
import type { MembershipStatus, ProjectRole } from './permissions'
import type { NameMode, SpaceRole, SpaceMembershipStatus, SpaceStatus } from './community'

/** 익명 스터디 기록에서 다른 멤버를 부르는 이름. */
export const STUDY_MEMBER_LABEL = '스터디 멤버'

/** 공개 후보 당사자 범위: 스터디 기록은 내용이 없어도 지금 방 멤버 모두가 동의 당사자입니다. */
export const STUDY_MEMBER_SCOPE = 'study_member'

/** 방 역할·상태 → 과제 역할. active 멤버가 아니면 null(과제 멤버 아님). */
export function studyProjectRole(role: SpaceRole, status: SpaceMembershipStatus, spaceStatus: SpaceStatus): ProjectRole | null {
  if (status !== 'active') return null
  if (role === 'owner') return 'owner'
  return spaceStatus === 'active' ? 'editor' : 'viewer'
}

export interface StudySpaceMember {
  userId: string
  role: SpaceRole
  status: SpaceMembershipStatus
}

export interface StudyProjectMember {
  userId: string
  role: ProjectRole
  status: MembershipStatus
}

export interface StudyRecordSyncPlan {
  /** 새로 넣을 과제 멤버(active). */
  inserts: Array<{ userId: string; role: ProjectRole }>
  /** 바꿀 과제 멤버(역할·상태). */
  updates: Array<{ userId: string; role: ProjectRole; status: MembershipStatus }>
  /** 과제 owner_id로 둘 사람(방에 active owner가 없으면 null — 지금 값을 그대로 둠). */
  ownerId: string | null
}

/**
 * 방 멤버십 → 과제 멤버십 계산(멱등). 같은 입력에 두 번 적용해도 두 번째 계획은 비어 있습니다.
 * - 방 active → 과제 active + 대응 역할.
 * - 방에서 나감(left)·승인 대기 취소 → left, 내보냄·거절(removed)·방 멤버십 행 없음(탈퇴 정리) → removed. 이미 left/removed면 그대로.
 * - 과제 멤버였던 적 없는 사람이 active가 아니면 아무것도 넣지 않습니다.
 */
export function planStudyRecordSync(
  space: readonly StudySpaceMember[],
  project: readonly StudyProjectMember[],
  spaceStatus: SpaceStatus,
): StudyRecordSyncPlan {
  const plan: StudyRecordSyncPlan = { inserts: [], updates: [], ownerId: null }
  const spaceBy = new Map(space.map((m) => [m.userId, m]))
  const projectBy = new Map(project.map((m) => [m.userId, m]))
  const ids = [...new Set([...spaceBy.keys(), ...projectBy.keys()])].sort()
  for (const userId of ids) {
    const s = spaceBy.get(userId)
    const p = projectBy.get(userId)
    const role = s ? studyProjectRole(s.role, s.status, spaceStatus) : null
    if (role === 'owner') plan.ownerId = userId
    if (role) {
      if (!p) plan.inserts.push({ userId, role })
      else if (p.role !== role || p.status !== 'active') plan.updates.push({ userId, role, status: 'active' })
      continue
    }
    if (!p || p.status === 'left' || p.status === 'removed') continue
    // active(또는 invited)였는데 더는 방의 active 멤버가 아님. owner 역할은 내려 둡니다(과제에 owner가 둘 남지 않게).
    const ended: MembershipStatus = s && s.status === 'left' ? 'left' : s && s.status === 'pending' ? 'left' : 'removed'
    plan.updates.push({ userId, role: p.role === 'owner' ? 'editor' : p.role, status: ended })
  }
  return plan
}

/** 공개 후보·release 스냅샷에 고정한 스터디 방식이 익명인지. 스터디 기록이 아니면 false. */
export function isAnonymousStudySnapshot(snapshot: { kind?: unknown; studyNameMode?: unknown }): boolean {
  return snapshot.kind === 'study' && snapshot.studyNameMode === 'anonymous'
}

/**
 * 이 release를 포트폴리오(케이스 스터디)·공개 프로필·모집 지원 첨부에 연결할 수 있는지.
 * 익명 스터디 방의 기록은 연결하지 않습니다(§8.9.5 "익명 스터디 방은 기록을 포트폴리오에 연결하지 않습니다").
 */
export function canLinkReleaseToPortfolio(snapshot: { kind?: unknown; studyNameMode?: unknown }): boolean {
  return !isAnonymousStudySnapshot(snapshot)
}

/** 공개 후보의 노출 선택이 스터디 방식과 맞는지. 익명 스터디는 이름 노출('name')을 고를 수 없습니다. */
export function studyExposureAllowed(nameMode: NameMode | null, exposure: Readonly<Record<string, 'name' | 'anonymous'>>): boolean {
  if (nameMode !== 'anonymous') return true
  return Object.values(exposure).every((mode) => mode === 'anonymous')
}

/**
 * 익명 스터디 기록 안에서 사람 이름을 가리는 표. 본인은 자기 이름, 다른 사람은 과제 멤버가 된 순서대로 "스터디 멤버 N".
 * `orderedUserIds`의 순서가 번호입니다(웹은 과제별 멤버 가명 키 순서 — 가입 순서와 잇지 않음, ADR 0026 부록). 목록에 없는 사람(예: 오래전 정리된 계정)은 번호 없이 "스터디 멤버".
 */
export function studyMemberLabels(orderedUserIds: readonly string[]): (userId: string) => string {
  const index = new Map(orderedUserIds.map((id, i) => [id, i + 1]))
  return (userId) => {
    const n = index.get(userId)
    return n ? `${STUDY_MEMBER_LABEL} ${n}` : STUDY_MEMBER_LABEL
  }
}
