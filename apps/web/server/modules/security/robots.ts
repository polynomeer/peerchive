/**
 * `/robots.txt`(C-05, SYSTEM_DESIGN §8.2, ADR 0021). h3만 써서 테스트에서 그대로 조립합니다.
 *
 * - 공개 색인 설정(`PEERCHIVE_PUBLIC_INDEXING`, ADR 0012)이 꺼져 있으면(파일럿 기본) 전부 막습니다(`Disallow: /`).
 * - 켜져 있으면 첫 화면(`/`)·공개 페이지(`/p/`·`/c/`·`/u/`·`/search`)와 공개 조회 API(`/api/v1/public/`)만 열고(나머지는 기본 차단), 커뮤니티·개인 화면·나머지 API는 막습니다.
 *   `/c/`(과목 허브)는 끝 슬래시를 붙여 `/community`와 겹치지 않게 합니다.
 * - 사이트맵은 없고 `Sitemap:` 줄도 넣지 않습니다. 사이트맵을 만들면 커뮤니티 경로를 넣지 않아야 합니다(test/community-visibility가 검사).
 * - robots.txt는 보조 장치입니다. 실제 차단은 로그인·정책 함수이고, 커뮤니티 응답은 설정과 무관하게 항상 noindex입니다.
 * - 요청마다 환경 변수를 읽습니다(공개 조회 X-Robots-Tag와 같은 설정, 재시작 없이 테스트 가능).
 */
import { defineEventHandler, setResponseHeaders, type EventHandler } from 'h3'
import { publicIndexingAllowed } from '../publication/public-http'

type Env = Readonly<Record<string, string | undefined>>

/** 공개 색인을 허용해도 막는 경로. 커뮤니티가 맨 앞입니다. */
export const ROBOTS_DISALLOWED_PATHS = [
  '/community',
  '/api/v1/community',
  '/api/',
  '/settings',
  '/me',
  '/operator',
  '/projects',
  '/portfolio',
  '/consents',
  '/invite/',
  '/auth/',
  '/login',
  '/onboarding',
  '/senior-notes',
] as const

/** 공개 색인을 허용할 때만 여는 공개 경로(ADR 0012·0013·0014). */
export const ROBOTS_PUBLIC_PATHS = ['/p/', '/c/', '/u/', '/search', '/api/v1/public/'] as const

export function robotsTxt(env: Env): string {
  if (!publicIndexingAllowed(env)) {
    return ['# Peerchive: 파일럿 동안 검색엔진 색인을 허용하지 않습니다(PEERCHIVE_PUBLIC_INDEXING 꺼짐).', 'User-agent: *', 'Disallow: /', ''].join('\n')
  }
  return [
    '# Peerchive: 공개 사례·과목 허브·공개 프로필·검색만 색인을 허용합니다. 커뮤니티와 개인 화면은 항상 막습니다.',
    'User-agent: *',
    ...ROBOTS_DISALLOWED_PATHS.map((p) => `Disallow: ${p}`),
    ...ROBOTS_PUBLIC_PATHS.map((p) => `Allow: ${p}`),
    'Allow: /$',
    'Disallow: /',
    '',
  ].join('\n')
}

export function createRobotsHandler(getEnv: () => Env = () => process.env): EventHandler {
  return defineEventHandler((event) => {
    setResponseHeaders(event, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    return robotsTxt(getEnv())
  })
}
