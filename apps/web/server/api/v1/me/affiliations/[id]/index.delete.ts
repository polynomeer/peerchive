import { removeAffiliation } from '../../../../../modules/affiliation/affiliations'

/** DELETE /api/v1/me/affiliations/:id — 200 + revoked 소속(메일 해시 삭제, 이력 유지). 404. */
export default defineApiHandler(async (event) => removeAffiliation(requireDb(), requireActor(event), getRouterParam(event, 'id')))
