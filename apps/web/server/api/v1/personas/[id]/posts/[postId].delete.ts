import { deleteProfilePost } from '../../../../../modules/social/profile-posts'

/** DELETE /api/v1/personas/:id/posts/:postId — 내 프로필 글 지우기(S-05). 204. 남의 것·없는 id 404, 운영 숨김 글 409 `hidden`. */
export default defineApiHandler(async (event) => {
  await deleteProfilePost(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'postId'))
  setResponseStatus(event, 204)
  return null
})
