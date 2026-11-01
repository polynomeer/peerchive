import { revokeInviteCode } from '../../../../../modules/institutions/institutions'

/** POST /api/v1/operator/invite-codes/:id/revoke — 운영자만(I-01). 200. 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => revokeInviteCode(requireDb(), requireActor(event), getRouterParam(event, 'id')))
