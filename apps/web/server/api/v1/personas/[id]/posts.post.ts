import { createProfilePost } from '../../../../modules/social/profile-posts'

/**
 * POST /api/v1/personas/:id/posts {body} — 내 페르소나의 프로필 글(S-05, 1~500자, 글만). 201.
 * 남의 페르소나 404, 프로필 없음 409 `profile_required`, 본문 422 `body: required|too_long`, 미디어 422 `mediaVersionIds: not_supported`, 한도 429.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const post = await createProfilePost(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return post
})
