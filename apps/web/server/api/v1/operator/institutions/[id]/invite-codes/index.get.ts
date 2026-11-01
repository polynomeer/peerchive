import { listInviteCodes } from '../../../../../../modules/institutions/institutions'

/** GET /api/v1/operator/institutions/:id/invite-codes — 운영자만(I-01). 원문 없이 목록. 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => listInviteCodes(requireDb(), requireActor(event), getRouterParam(event, 'id')))
