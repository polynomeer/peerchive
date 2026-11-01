import { requestAlbumUpload } from '../../../../../../../modules/community/room-album'

/** POST /api/v1/community/spaces/:slug/album/photos {declaredType, fileName, byteSize, caption?} — 사진 올리기 요청(A-02). 201 + uploadUrl(PUT, 15분). */
export default defineApiHandler(async (event) => {
  const result = await requestAlbumUpload(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
