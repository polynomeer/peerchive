// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',
  devtools: { enabled: false },
  telemetry: false,
  typescript: {
    strict: true,
    typeCheck: false, // `pnpm typecheck`(nuxt typecheck)로 별도 실행합니다.
  },
  app: {
    head: {
      htmlAttrs: { lang: 'ko' },
      title: 'Peerchive',
      meta: [{ name: 'description', content: '과제는 끝나도, 과정은 남는다' }],
    },
  },
  runtimeConfig: {
    // NUXT_DATABASE_URL 또는 DATABASE_URL(서버 전용). 클라이언트로 노출하지 않습니다.
    databaseUrl: '',
  },
})
