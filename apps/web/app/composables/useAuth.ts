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

  async function logout(): Promise<void> {
    try {
      await $fetch('/api/v1/auth/logout', { method: 'POST' })
    } finally {
      me.value = null
      await navigateTo('/login')
    }
  }

  return { me, refresh, ensure, logout }
}
