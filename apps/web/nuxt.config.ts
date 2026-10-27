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
  nitro: {
    hooks: {
      // nitro가 만드는 타입 라우트 표(.nuxt/types/nitro-routes.d.ts)를 비웁니다(ADR 0032). 표를 쓰는 $fetch·useFetch 타입은 URL을
      // 표의 모든 경로와 맞춰 보는데(경로 점수 계산), 라우트가 200개를 넘자 제네릭을 준 호출(`$fetch<T>`)뿐 아니라 제네릭 없는
      // 템플릿 문자열 URL의 `$fetch(url)` 한 줄도 TS2589(타입 인스턴스화 한도)에 닿았습니다. 화면은 응답 타입을 shared/types/api의 DTO로
      // 직접 주므로(`$fetch<T>`) 표에서 얻던 것은 제네릭 없는 호출의 메서드·응답 추론뿐입니다. 서버 라우팅·런타임에는 영향이 없습니다(타입 파일만).
      'types:extend'(types) {
        types.routes = {}
      },
    },
  },
  runtimeConfig: {
    // NUXT_DATABASE_URL 또는 DATABASE_URL(서버 전용). 클라이언트로 노출하지 않습니다.
    databaseUrl: '',
    // NUXT_SITE_ORIGIN: 허용 사이트 origin(쉼표 구분). 첫 항목으로 로그인·초대 링크를 만들고,
    // 상태 변경 API의 Origin/Referer 검사(CSRF)에 씁니다. 배포 시 반드시 실제 origin으로 설정하세요.
    siteOrigin: 'http://localhost:3000',
    // NUXT_MAIL_TRANSPORT(또는 우선하는 PEERCHIVE_MAIL_TRANSPORT): 'smtp'(실제 발송, PEERCHIVE_SMTP_*·PEERCHIVE_MAIL_FROM)
    // 또는 'dev-console'(개발 전용, 링크를 서버 콘솔에 출력). production에서는 올바른 smtp가 아니면 서버가 시작되지 않습니다.
    mailTransport: 'dev-console',
  },
})
