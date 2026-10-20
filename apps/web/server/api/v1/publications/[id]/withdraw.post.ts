import { withdrawPublication } from '../../../../modules/publication/releases'

/**
 * POST /api/v1/publications/:id/withdraw {reason?} — owner만. 200 + 공개 요약(이미 철회됐으면 그대로 200).
 * 커밋 즉시 공개 조회·파일이 404. 403(owner 아님), 404, 409 not_published.
 */
export default defineApiHandler(async (event) =>
  withdrawPublication(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
