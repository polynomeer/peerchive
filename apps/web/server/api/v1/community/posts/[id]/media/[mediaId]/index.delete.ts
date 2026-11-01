import { deleteLoungeMedia } from '../../../../../../../modules/community/lounge-media'

/** DELETE /api/v1/community/posts/:id/media/:mediaId — 라운지 이미지 지우기(A-04). 올린 본인만(그 밖 404). 플래그가 꺼지면 404. */
export default defineApiHandler(async (event) =>
  deleteLoungeMedia(requireDb(), useObjectStorage(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'mediaId')),
)
