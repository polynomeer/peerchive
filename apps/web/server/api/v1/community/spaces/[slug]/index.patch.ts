import { updateSpace } from '../../../../../modules/community/spaces'

/** PATCH /api/v1/community/spaces/:slug {name?, description?, discovery?, joinPolicy?} — 사용자 방 owner·admin, 공식 페이지 운영자. 이름 표시 방식은 422 not_editable(C-03). */
export default defineApiHandler(async (event) => updateSpace(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event)))
