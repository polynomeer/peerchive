/**
 * 마일스톤·스냅샷 규칙 (PROOFU_EVOLUTION_PLAN §6.3, SYSTEM_DESIGN §6.3 Milestone/MilestoneSnapshot, T-06).
 *
 * - 마일스톤은 순서 안내이며 완료 게이트가 아닙니다. 이름은 자유이고 순서를 바꿀 수 있습니다.
 * - 관리(만들기·수정·순서 변경·삭제·스냅샷 지정)는 active owner/editor. reviewer/viewer는 읽기만 하며,
 *   관리자라는 사실만으로는 아무 권한도 생기지 않습니다(§8).
 * - 스냅샷은 같은 프로젝트의 검사 통과(`clean`) 산출물 버전만 지정합니다. 빌드 로그 근거(검사 중도 허용)보다 엄격합니다:
 *   진화 보기는 바로 열어 볼 수 있는 자료만 나란히 보여 주기 때문입니다.
 * - 한도: 프로젝트당 마일스톤 12개, 마일스톤당 스냅샷 6개.
 */
import { type Membership, type ProjectRef, type Viewer, canReadProjectWorkspace } from './permissions'
import type { ScanStatus } from './artifacts'

/** 프로젝트당 마일스톤 최대 개수. */
export const MILESTONE_LIMIT = 12
/** 마일스톤당 스냅샷 최대 개수. */
export const SNAPSHOT_LIMIT = 6

/**
 * 빈 프로젝트에 한 번에 불러올 수 있는 기본 단계(§6.3 예시). 과목 허브의 공통 템플릿이 생기면 그쪽에서 고르게 됩니다.
 */
export const MILESTONE_TEMPLATE: readonly string[] = ['기획', '중간발표', '구현', '검증', '최종제출']

/** 마일스톤 관리(만들기·수정·순서 변경·삭제·스냅샷 지정/해제): active owner/editor. */
export function canManageMilestones(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && (membership!.role === 'owner' || membership!.role === 'editor')
}

export type OrderCheck = 'ok' | 'duplicate' | 'mismatch'

/**
 * 순서 변경 요청 판정. 요청은 지금 있는 마일스톤 id 전체의 순열이어야 합니다.
 *
 * - 같은 id가 두 번 나오면 `duplicate`
 * - 빠진 id·모르는 id(다른 프로젝트 포함)가 있으면 `mismatch`. 그 사이 다른 멤버가 추가·삭제한 경우도 여기에 해당하며,
 *   호출자는 최신 목록을 다시 읽어 순서를 고르게 합니다.
 */
export function checkMilestoneOrder(existingIds: readonly string[], requestedIds: readonly string[]): OrderCheck {
  if (new Set(requestedIds).size !== requestedIds.length) return 'duplicate'
  if (requestedIds.length !== existingIds.length) return 'mismatch'
  const existing = new Set(existingIds)
  return requestedIds.every((id) => existing.has(id)) ? 'ok' : 'mismatch'
}

/** 스냅샷으로 지정할 수 있는 검사 상태: `clean`만. 검사 중·격리·실패 버전은 지정할 수 없습니다. */
export function canUseAsSnapshot(status: ScanStatus): boolean {
  return status === 'clean'
}

/** 스냅샷 후보로 고른 산출물 버전. 없으면(또는 읽을 수 없으면) null. */
export interface SnapshotTarget {
  projectId: string
  scanStatus: ScanStatus
}

export type SnapshotCheck = 'ok' | 'not_found' | 'not_clean'

/**
 * 스냅샷 지정 판정.
 * - 버전이 없거나 다른 프로젝트 것이면 `not_found`. 다른 프로젝트 자료의 존재를 드러내지 않도록 둘을 구분하지 않습니다.
 * - 같은 프로젝트지만 clean이 아니면 `not_clean`.
 */
export function checkSnapshotTarget(projectId: string, target: SnapshotTarget | null | undefined): SnapshotCheck {
  if (!target || target.projectId !== projectId) return 'not_found'
  return canUseAsSnapshot(target.scanStatus) ? 'ok' : 'not_clean'
}
