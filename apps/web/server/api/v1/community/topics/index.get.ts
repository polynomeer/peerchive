import { listTopics } from '../../../../modules/community/topics'

/** GET /api/v1/community/topics — 학교를 넘나드는 토픽 목록(A-05, P2 topics 플래그, 꺼짐 404). 활성 기관 인증이 없으면 eligible false + 빈 목록. */
export default defineApiHandler(async (event) => listTopics(requireDb(), requireActor(event)))
