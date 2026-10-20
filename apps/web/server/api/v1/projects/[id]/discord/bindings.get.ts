import { listBindings } from '../../../../../modules/discord/bindings'

/** GET /api/v1/projects/:id/discord/bindings — 멤버. 연결된 디스코드 채널(id만). */
export default defineApiHandler((event) => listBindings(requireDb(), requireActor(event), getRouterParam(event, 'id')))
