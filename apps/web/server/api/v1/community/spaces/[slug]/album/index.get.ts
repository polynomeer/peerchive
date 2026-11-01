import { getAlbum } from '../../../../../../modules/community/room-album'

/** GET /api/v1/community/spaces/:slug/album — 동문회·OB 방 앨범(A-02). 검사를 통과한 사진만, 사진마다 이 사람에게만 맞는 5분 서명 URL. 방 멤버만(404). */
export default defineApiHandler(async (event) => getAlbum(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
