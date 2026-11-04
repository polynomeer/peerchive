import { acceptCuratorProposal } from '../../../../../modules/curators/assignments'

/** POST /api/v1/me/curator-proposals/:id/accept — 제안 수락(ADR 0060 D-08). 200, 404, 409 `curator_not_eligible`. */
export default defineApiHandler((event) => acceptCuratorProposal(requireDb(), requireActor(event), getRouterParam(event, 'id')))
