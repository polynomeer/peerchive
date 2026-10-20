import type { MilestoneDto } from '~~/shared/types/api'

/**
 * 과제의 마일스톤 목록(마일스톤 섹션·진화 보기·빌드 로그의 마일스톤 선택과 구분선이 함께 씀).
 * 프로젝트별 공유 상태이며 클라이언트에서 불러옵니다.
 */
export function useProjectMilestones(projectId: string) {
  const items = useState<MilestoneDto[]>(`milestones:${projectId}`, () => [])
  const loaded = useState<boolean>(`milestones-loaded:${projectId}`, () => false)
  const loadError = useState<boolean>(`milestones-error:${projectId}`, () => false)

  async function refresh() {
    try {
      items.value = await $fetch<MilestoneDto[]>(`/api/v1/projects/${projectId}/milestones`)
      loadError.value = false
    } catch {
      loadError.value = true
    } finally {
      loaded.value = true
    }
  }

  /** 한 건을 바꿔 끼웁니다(순서는 서버 position 기준으로 다시 정렬). */
  function replace(milestone: MilestoneDto) {
    const exists = items.value.some((item) => item.id === milestone.id)
    const next = exists ? items.value.map((item) => (item.id === milestone.id ? milestone : item)) : [...items.value, milestone]
    items.value = next.sort((a, b) => a.position - b.position)
  }

  const byId = computed(() => new Map(items.value.map((item) => [item.id, item])))

  return { items, loaded, loadError, refresh, replace, byId }
}
