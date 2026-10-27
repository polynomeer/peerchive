import { setReaction } from '../../../../../modules/community/posts'

/** DELETE /api/v1/community/comments/:id/reaction — 공감 취소. {count, reacted}. */
export default defineApiHandler(async (event) => setReaction(requireDb(), requireActor(event), 'comment', getRouterParam(event, 'id'), false))
