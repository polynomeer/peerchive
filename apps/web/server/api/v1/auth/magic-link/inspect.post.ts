import { inspectMagicLink } from '../../../../modules/identity/magic-link'

/**
 * POST /api/v1/auth/magic-link/inspect {token}
 * 토큰을 소비하지 않고 로그인 대상 계정(가린 이메일)만 알려 줍니다. 무효 토큰은 410.
 */
export default defineApiHandler(async (event) => {
  const body = (await readJsonBody(event)) as { token?: unknown }
  const result = await inspectMagicLink(requireDb(), { token: body.token })
  if (!result.ok) throw createError({ statusCode: 410, statusMessage: 'Gone', data: { code: 'link_invalid' } })
  return { maskedEmail: result.maskedEmail }
})
