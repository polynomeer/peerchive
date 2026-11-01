import { listLogComments } from '../../../../../modules/logs/comments'

/** GET /api/v1/logs/:id/comments — 로그 피드백 댓글(E-10, 팀 안에서만, 오래된 순). 읽을 수 없으면 404. */
export default defineApiHandler((event) => listLogComments(requireDb(), requireActor(event), getRouterParam(event, 'id')))
