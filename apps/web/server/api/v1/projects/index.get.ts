import { listMyProjects } from '../../../modules/projects/projects'

/** GET /api/v1/projects — 요청자가 active 멤버인 프로젝트. */
export default defineApiHandler((event) => listMyProjects(requireDb(), requireActor(event)))
