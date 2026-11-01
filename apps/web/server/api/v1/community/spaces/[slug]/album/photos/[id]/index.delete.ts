import { deleteAlbumPhoto } from '../../../../../../../../modules/community/room-album'

/** DELETE /api/v1/community/spaces/:slug/album/photos/:id — 올린 본인 또는 방장·운영진(A-02). 행과 파일을 지웁니다. */
export default defineApiHandler(async (event) =>
  deleteAlbumPhoto(requireDb(), useObjectStorage(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id')),
)
