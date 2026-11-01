import { approveTagMergeProposal } from '../../../../../modules/curators/tag-proposals'

/** POST /api/v1/operator/concept-tag-proposals/:id/approve — 운영자만(E-03). 기존 태그 병합을 실행하고 승인. 409 already_decided·병합 규칙 오류. */
export default defineApiHandler((event) => approveTagMergeProposal(requireDb(), requireActor(event), getRouterParam(event, 'id')))
