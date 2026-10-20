import { decideConsent } from '../../../../modules/publication/candidates'

/**
 * POST /api/v1/candidates/:id/consents {decision: 'granted'|'declined', manifestHash, note?} — 당사자 본인. 200 + 후보.
 * 당사자 아님 403 not_subject, 대체됨 409 superseded, 해시 다름 409 stale_manifest(+currentManifestHash), 볼 수 없으면 404.
 */
export default defineApiHandler(async (event) =>
  decideConsent(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
