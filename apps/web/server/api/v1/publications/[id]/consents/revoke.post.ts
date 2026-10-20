import { revokeConsent } from '../../../../../modules/publication/releases'

/**
 * POST /api/v1/publications/:id/consents/revoke {note?} — 지금 release의 당사자 본인. 200.
 * 게시 중이면 같은 트랜잭션에서 공개를 철회합니다(원인 consent_revoked). 당사자 아님: 멤버 403 not_subject, 그 밖에는 404.
 */
export default defineApiHandler(async (event) =>
  revokeConsent(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
