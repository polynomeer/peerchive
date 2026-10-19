/** 첫 렌더링 전에 로그인 상태를 확인합니다(SSR 결과가 클라이언트로 이어짐). */
export default defineNuxtPlugin(async () => {
  await useAuth().ensure()
})
