import { getProject } from '../../../../modules/projects/projects'

/** GET /api/v1/projects/:id — 멤버가 아니거나 없으면 404. */
export default defineApiHandler((event) => getProject(requireDb(), requireActor(event), getRouterParam(event, 'id')))
