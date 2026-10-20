/**
 * 마일스톤 화면 도우미(T-06): 표시 문구, 스냅샷 후보, 순서 이동, 오류 안내.
 * 상태는 색이 아니라 텍스트로 보여 줍니다(시나리오 H).
 */
import type { ArtifactDto, MilestoneDto, MilestoneRefDto, ScanStatus } from '~~/shared/types/api'

/** 서버 한도·기본 단계와 같은 값(@peerchive/domain). 화면 안내용이며 최종 판정은 서버가 합니다. */
export const MILESTONE_MAX = 12
export const SNAPSHOT_MAX = 6
export const MILESTONE_TEMPLATE_LABEL = '기획 → 중간발표 → 구현 → 검증 → 최종제출'

/** "마일스톤 2: 중간발표" */
export function milestoneLabel(milestone: Pick<MilestoneRefDto, 'position' | 'title'>): string {
  return `마일스톤 ${milestone.position}: ${milestone.title}`
}

/** YYYY-MM-DD → "10/20"(올해) 또는 "2027/1/5". 시간대 변환 없이 날짜 문자열 그대로 씁니다. */
export function formatDay(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return year === new Date().getFullYear() ? `${month}/${day}` : `${year}/${month}/${day}`
}

/** 스냅샷으로 고를 수 있는 산출물 버전. 격리·실패 버전은 목록에서 뺍니다. */
export interface SnapshotOption {
  versionId: string
  label: string
  scanStatus: ScanStatus
  /** 고를 수 없는 이유(검사 중·이미 지정됨). 고를 수 있으면 null. */
  disabledReason: string | null
}

export function snapshotOptions(artifacts: ArtifactDto[], milestone: MilestoneDto): SnapshotOption[] {
  const taken = new Set(milestone.snapshots.map((s) => s.artifactVersionId))
  return artifacts.flatMap((artifact) =>
    artifact.versions
      .filter((version) => version.scanStatus !== 'quarantined' && version.scanStatus !== 'failed')
      .map((version) => ({
        versionId: version.id,
        label: `${artifact.title} v${version.versionNo}`,
        scanStatus: version.scanStatus,
        disabledReason: taken.has(version.id) ? '이미 지정됨' : version.scanStatus === 'clean' ? null : '검사 중',
      })),
  )
}

/** ids에서 index 위치의 항목을 delta(-1 위로, +1 아래로)만큼 옮긴 새 배열. 범위를 벗어나면 null. */
export function moveId(ids: readonly string[], index: number, delta: -1 | 1): string[] | null {
  const target = index + delta
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return null
  const next = [...ids]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}

const MILESTONE_ERRORS: Record<string, string> = {
  limit_reached: '한도에 도달했습니다.',
  in_use: '이 마일스톤을 가리키는 로그(이전 수정본 포함)가 있어 삭제할 수 없습니다. 이름을 바꾸거나 순서를 옮겨 쓰세요.',
  duplicate: '이미 이 마일스톤에 지정한 파일입니다.',
  not_empty: '이미 마일스톤이 있어 기본 단계를 불러올 수 없습니다.',
  version_conflict: '다른 멤버가 먼저 수정했습니다. 최신 내용을 불러왔으니 확인한 뒤 다시 저장하세요.',
}

/** 409 등 이유 코드 → 안내 문구. */
export function milestoneErrorMessage(code: string, fallback: string): string {
  return MILESTONE_ERRORS[code] ?? fallback
}
