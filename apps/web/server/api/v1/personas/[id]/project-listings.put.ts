import { setProjectListing } from '../../../../modules/social/visibility'

/**
 * PUT /api/v1/personas/:id/project-listings {projectId, shown} — 과제를 과제 수행 목록에 올리거나 내림(S-03, 본인만).
 * active 멤버가 아니면 404, 표시명 페르소나 409 `real_persona_only`, 익명·표시명 스터디 방 기록 409 `anonymous_study`·`display_study`.
 * 과제 id를 경로가 아니라 본문에 둡니다(라우트 하나로 GET·PUT, nuxt.config의 타입 라우트 표 주석 참고).
 */
export default defineApiHandler(async (event) => setProjectListing(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
