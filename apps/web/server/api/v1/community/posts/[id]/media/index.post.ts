import { requestLoungeMediaUpload } from '../../../../../../modules/community/lounge-media'

/** POST /api/v1/community/posts/:id/media {declaredType, fileName, byteSize} — 공감 라운지 글에 이미지 붙이기 요청(A-04). 201 + uploadUrl(PUT, 15분). 플래그가 꺼지면 404. */
export default defineApiHandler(async (event) => {
  const result = await requestLoungeMediaUpload(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
