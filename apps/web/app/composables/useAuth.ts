import type { MeDto } from '~~/shared/types/api'

/**
 * 로그인 상태. `undefined`는 아직 확인 전, `null`은 로그인하지 않음.
 * SSR에서는 요청 쿠키를 그대로 전달해 /api/v1/me를 확인합니다(useRequestFetch).
 */
export function useAuth() {
  const me = useState<MeDto | null | undefined>('me', () => undefined)
  const requestFetch = useRequestFetch()

  async function refresh(): Promise<MeDto | null> {
    try {
      me.value = await requestFetch<MeDto>('/api/v1/me')
    } catch {
      me.value = null
    }
    return me.value
  }

  async function ensure(): Promise<MeDto | null> {
    if (me.value === undefined) return refresh()
    return me.value
  }

  /**
   * 로그아웃. 서버 세션을 지운 뒤 화면에 남은 비공개 데이터(useAsyncData 캐시·useState, 첫 SSR 응답에 담긴 payload)를 버리도록
   * 앱을 새로 불러옵니다(C-05: 커뮤니티 방 이름·게시판이 로그아웃 뒤 뒤로 가기·같은 키 재사용으로 다시 보이지 않게).
   */
  async function logout(): Promise<void> {
    try {
      await $fetch('/api/v1/auth/logout', { method: 'POST' })
    } finally {
      me.value = null
      clearNuxtData()
      clearNuxtState((key) => key !== 'me')
      if (import.meta.client) reloadNuxtApp({ path: '/login', force: true, persistState: false })
      else await navigateTo('/login')
    }
  }

  return { me, refresh, ensure, logout }
}
