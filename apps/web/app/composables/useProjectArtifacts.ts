import type { ArtifactDto } from '~~/shared/types/api'

/**
 * 과제의 산출물 목록(산출물 섹션과 빌드 로그 근거 선택이 함께 씀). 프로젝트별 공유 상태이며 클라이언트에서 불러옵니다.
 */
export function useProjectArtifacts(projectId: string) {
  const items = useState<ArtifactDto[]>(`artifacts:${projectId}`, () => [])
  const loaded = useState<boolean>(`artifacts-loaded:${projectId}`, () => false)
  const loadError = useState<boolean>(`artifacts-error:${projectId}`, () => false)

  async function refresh() {
    try {
      items.value = await $fetch<ArtifactDto[]>(`/api/v1/projects/${projectId}/artifacts`)
      loadError.value = false
    } catch {
      loadError.value = true
    } finally {
      loaded.value = true
    }
  }

  function replace(artifact: ArtifactDto) {
    const exists = items.value.some((item) => item.id === artifact.id)
    items.value = exists
      ? items.value.map((item) => (item.id === artifact.id ? artifact : item))
      : [artifact, ...items.value]
  }

  return { items, loaded, loadError, refresh, replace }
}
