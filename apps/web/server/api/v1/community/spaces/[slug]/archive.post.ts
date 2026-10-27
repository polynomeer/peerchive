import { archiveSpace } from '../../../../../modules/community/spaces'

/** POST /api/v1/community/spaces/:slug/archive — 사용자 방 owner, 공식 페이지 운영자. 보관된 방은 읽기만. */
export default defineApiHandler(async (event) => archiveSpace(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
