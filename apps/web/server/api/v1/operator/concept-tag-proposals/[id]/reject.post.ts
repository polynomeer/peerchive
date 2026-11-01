import { rejectTagMergeProposal } from '../../../../../modules/curators/tag-proposals'

/** POST /api/v1/operator/concept-tag-proposals/:id/reject — 운영자만(E-03). 409 already_decided. */
export default defineApiHandler((event) => rejectTagMergeProposal(requireDb(), requireActor(event), getRouterParam(event, 'id')))
