import { listTagMergeProposals } from '../../../../modules/curators/tag-proposals'

/** GET /api/v1/operator/concept-tag-proposals?status=pending|approved|rejected — 운영자만(E-03). 큐레이터의 개념 태그 병합 제안. */
export default defineApiHandler((event) => listTagMergeProposals(requireDb(), requireActor(event), getQuery(event)))
