/** 로그인 필수 페이지. 프로필이 없으면 온보딩으로 보냅니다. */
export default defineNuxtRouteMiddleware(async (to) => {
  const me = await useAuth().ensure()
  if (!me) return navigateTo('/login')
  if (!me.profile && to.path !== '/onboarding') return navigateTo('/onboarding')
})
