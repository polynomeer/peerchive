import { verifyAffiliation } from '../../../../../modules/affiliation/affiliations'

/**
 * POST /api/v1/me/affiliations/:id/verify {code} — 200 + active 소속. 422 code_mismatch(+attemptsLeft)·code invalid_format,
 * 410 code_expired·attempts_exceeded·code_unavailable, 409 email_in_use, 404.
 */
export default defineApiHandler(async (event) =>
  verifyAffiliation(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
