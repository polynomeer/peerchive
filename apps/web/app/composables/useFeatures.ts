import type { FeatureFlagsDto } from '~~/shared/types/api'

/**
 * P2 기능 플래그(ADR 0037). 서버가 `GET /api/v1/features`로 내려주는 값을 한 번 읽어 화면 진입점을 숨기는 데 씁니다.
 * 읽지 못하면 모두 꺼진 것으로 봅니다. 권한 판정은 서버가 따로 합니다(꺼진 영역의 API는 404).
 */
export function useFeatures() {
  const flags = useState<FeatureFlagsDto>('p2-features', () => ({ alumni: false, topics: false, institutions: false }))
  const loaded = useState<boolean>('p2-features-loaded', () => false)

  async function ensure(): Promise<FeatureFlagsDto> {
    if (loaded.value) return flags.value
    try {
      flags.value = await useRequestFetch()<FeatureFlagsDto>('/api/v1/features')
    } catch {
      flags.value = { alumni: false, topics: false, institutions: false }
    }
    loaded.value = true
    return flags.value
  }

  return { flags, ensure }
}
