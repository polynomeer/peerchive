/**
 * 첫 렌더링 전에 로그인 상태를 확인합니다(SSR 결과가 클라이언트로 이어짐).
 * 공개 페이지(/p/**)에서는 확인하지 않습니다: SSR payload에 `me`(이메일 포함)가 실리지 않게 합니다(T-12, ADR 0012).
 * 거기서 다른 화면으로 옮기면 그때(클라이언트에서) 확인합니다.
 */
import { isPublicPagePath } from '~~/shared/utils/public-paths'

export default defineNuxtPlugin(async () => {
  const auth = useAuth()
  if (isPublicPagePath(useRequestURL().pathname)) {
    if (import.meta.client) {
      const stop = useRouter().afterEach((to) => {
        if (isPublicPagePath(to.path)) return
        stop()
        void auth.ensure()
      })
    }
    return
  }
  await auth.ensure()
})
