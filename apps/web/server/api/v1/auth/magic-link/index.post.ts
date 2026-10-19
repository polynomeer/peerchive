import { z } from 'zod'
import { requestMagicLink } from '../../../../modules/identity/magic-link'
import { parseInput } from '../../../../modules/validation'

const schema = z.object({
  email: z
    .string({ error: 'required' })
    .trim()
    .max(254, { error: 'too_long' })
    .pipe(z.email({ error: 'invalid_format' })),
})

/**
 * POST /api/v1/auth/magic-link {email}
 * 계정이 있든 없든, 이메일별 한도를 넘었든 같은 202를 돌려줍니다(계정 열거 방지).
 * IP별 한도를 넘으면 429(계정 정보와 무관).
 */
export default defineApiHandler(async (event) => {
  const input = parseInput(schema, await readJsonBody(event))
  const origin = primarySiteOrigin()
  const result = await requestMagicLink(requireDb(), {
    email: input.email,
    ip: requestIp(event),
    mail: useMailTransport(),
    // 토큰은 URL fragment(#)에 둡니다. fragment는 서버로 전송되지 않아 접근 로그·스캐너 요청에 남지 않습니다.
    buildVerifyUrl: (token) => `${origin}/auth/verify#token=${encodeURIComponent(token)}`,
  })
  if (result === 'rate_limited') {
    setResponseHeader(event, 'retry-after', 900)
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests', data: { code: 'rate_limited' } })
  }
  setResponseStatus(event, 202)
  return { status: 'accepted' as const }
})
