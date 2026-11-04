import { declineCuratorProposal } from '../../../../../modules/curators/assignments'

/** POST /api/v1/me/curator-proposals/:id/decline — 제안 거절(ADR 0060 D-08). 200, 404, 409 `already_accepted`. */
export default defineApiHandler((event) => declineCuratorProposal(requireDb(), requireActor(event), getRouterParam(event, 'id')))
