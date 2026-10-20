import { listMilestones } from '../../../../../modules/milestones/milestones'

/** GET /api/v1/projects/:id/milestones — 멤버(읽기 전용 포함). 순서대로, 스냅샷·로그 수 포함. */
export default defineApiHandler((event) => listMilestones(requireDb(), requireActor(event), getRouterParam(event, 'id')))
