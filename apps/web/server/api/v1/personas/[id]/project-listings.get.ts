import { listMyProjectListings } from '../../../../modules/social/visibility'

/** GET /api/v1/personas/:id/project-listings — 과제 수행 목록 고르기(S-03, 본인의 실명 페르소나만). 표시명 페르소나 409 `real_persona_only`. */
export default defineApiHandler((event) => listMyProjectListings(requireDb(), requireActor(event), getRouterParam(event, 'id')))
