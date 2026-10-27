/**
 * 커뮤니티 HTTP 경계(C-05, SYSTEM_DESIGN §8.2, ADR 0021). Nuxt 자동 import 없이 h3만 써서 테스트에서 그대로 조립합니다.
 *
 * - 경로: 화면 `/community`·`/community/**`, API `/api/v1/community`·`/api/v1/community/**`.
 * - 모든 응답(성공·오류·비로그인)에 `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
 *   `X-Content-Type-Options: nosniff`. robots 헤더·meta·robots.txt는 보조 장치이고 실제 차단은 로그인·정책 함수(canReadSpace·canPreviewSpace)입니다.
 * - 비로그인(세션 없음·무효·만료)은 handler·SSR에 닿기 전에 끊습니다.
 *   - 화면: 404 + 고정 HTML(`COMMUNITY_NOT_FOUND_HTML`). 존재하는 방·없는 방·초대 링크 모두 같은 바이트이고 Nuxt payload·방 이름·OG가 없습니다.
 *     링크 미리보기 봇(Slackbot·Discordbot 등)도 쿠키가 없으므로 이 응답을 받습니다.
 *   - API: 401 `unauthenticated`(모든 경로에서 같은 본문, 공간 조회 전이므로 존재 여부를 드러내지 않음). JSON 클라이언트가 "로그인 필요"를
 *     구분하도록 401을 유지합니다. 로그인한 사람에게 읽을 수 없는 공간은 서비스가 404입니다.
 */
import { createError, defineEventHandler, getRequestHeader, readRawBody, setResponseHeaders, setResponseStatus, type EventHandler, type H3Event } from 'h3'
import { COMMUNITY_WRITE_BODY_BYTES } from '@peerchive/domain'
import { ServiceError } from '../errors'
import { COMMUNITY_PAGE_TITLE, COMMUNITY_ROBOTS, isCommunityApiPath, isCommunityPagePath } from '../../../shared/utils/community-visibility'

export { COMMUNITY_PAGE_TITLE, COMMUNITY_ROBOTS, isCommunityApiPath, isCommunityPagePath }

export const COMMUNITY_RESPONSE_HEADERS = {
  'x-robots-tag': COMMUNITY_ROBOTS,
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

/**
 * 비로그인 화면 응답. 어떤 커뮤니티 주소에도 같은 내용이며 본문에는 고정 문구뿐입니다(방 이름·소개·OG·설명 meta 없음).
 * 로그인 링크는 있지만 "이 주소에 무엇이 있다"는 뜻을 담지 않습니다(없는 주소에도 똑같이 나옴).
 */
export const COMMUNITY_NOT_FOUND_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${COMMUNITY_ROBOTS}">
<meta name="referrer" content="no-referrer">
<title>${COMMUNITY_PAGE_TITLE}</title>
</head>
<body>
<main>
<h1>페이지를 찾을 수 없습니다</h1>
<p><a href="/login">로그인</a> · <a href="/">처음으로</a></p>
</main>
</body>
</html>
`

function applyHeaders(event: H3Event) {
  setResponseHeaders(event, COMMUNITY_RESPONSE_HEADERS)
}

/**
 * 서버 미들웨어(server/middleware/03.community.ts). `event.context.auth`는 02.auth가 채웁니다(커뮤니티 화면 경로도 세션을 검증).
 * 커뮤니티 경로가 아니면 아무것도 하지 않습니다.
 */
export function createCommunityGuard(): EventHandler {
  return defineEventHandler((event) => {
    const api = isCommunityApiPath(event.path)
    if (!api && !isCommunityPagePath(event.path)) return
    applyHeaders(event)
    if (event.context.auth) return
    if (api) throw createError({ statusCode: 401, statusMessage: 'Unauthorized', data: { code: 'unauthenticated' } })
    setResponseStatus(event, 404, 'Not Found')
    setResponseHeaders(event, { 'content-type': 'text/html; charset=utf-8' })
    return event.method === 'HEAD' ? '' : COMMUNITY_NOT_FOUND_HTML
  })
}

/**
 * 글·댓글 쓰기 요청 본문(C-04). 바이트 상한(COMMUNITY_WRITE_BODY_BYTES, 64KB)을 넘으면 파싱하기 전에 413 `too_large`,
 * JSON이 아니면 빈 객체(스키마 검증 422에 맡김). 글자 수 상한(제목 120·본문 10000·댓글 3000)은 서비스가 422로 확인합니다.
 */
export async function readCommunityWriteBody(event: H3Event): Promise<unknown> {
  const declared = Number(getRequestHeader(event, 'content-length') ?? '0')
  if (Number.isFinite(declared) && declared > COMMUNITY_WRITE_BODY_BYTES) throw new ServiceError('PAYLOAD_TOO_LARGE', 'too_large')
  const raw = await readRawBody(event, 'utf8')
  if (!raw) return {}
  if (Buffer.byteLength(raw, 'utf8') > COMMUNITY_WRITE_BODY_BYTES) throw new ServiceError('PAYLOAD_TOO_LARGE', 'too_large')
  try {
    return JSON.parse(raw) ?? {}
  } catch {
    return {}
  }
}
