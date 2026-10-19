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
  css: ['~/assets/main.css'],
  runtimeConfig: {
    // NUXT_DATABASE_URL 또는 DATABASE_URL(서버 전용). 클라이언트로 노출하지 않습니다.
    databaseUrl: '',
    // NUXT_SITE_ORIGIN: 허용 사이트 origin(쉼표 구분). 첫 항목으로 로그인·초대 링크를 만들고,
    // 상태 변경 API의 Origin/Referer 검사(CSRF)에 씁니다. 배포 시 반드시 실제 origin으로 설정하세요.
    siteOrigin: 'http://localhost:3000',
    // NUXT_MAIL_TRANSPORT: 현재 'dev-console'(개발 전용, 링크를 서버 콘솔에 출력)만 있습니다.
    // NODE_ENV=production에서 dev-console이면 서버가 시작되지 않습니다.
    mailTransport: 'dev-console',
  },
})
