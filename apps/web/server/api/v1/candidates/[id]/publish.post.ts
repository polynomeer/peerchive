import { publishCandidate } from '../../../../modules/publication/releases'

/**
 * POST /api/v1/candidates/:id/publish {manifestHash, idempotencyKey?} — owner만. 200 + {publication, release, idempotent}.
 * 트랜잭션 안에서 멤버십·엠바고·동의(현재 해시)·파일 clean·보류를 다시 검사합니다. 403(owner 아님), 404(볼 수 없음),
 * 409 superseded / stale_manifest / embargo_active / publish_blocked(+blockers) / publication_locked. 같은 후보·해시 재요청은 200 idempotent.
 */
export default defineApiHandler(async (event) =>
  publishCandidate(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
