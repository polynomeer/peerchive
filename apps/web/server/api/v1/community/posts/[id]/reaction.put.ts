import { setReaction } from '../../../../../modules/community/posts'

/** PUT /api/v1/community/posts/:id/reaction — 공감(사람마다 한 번, 비추천 없음). {count, reacted}. 409 own_item·target_not_open·space_not_active. */
export default defineApiHandler(async (event) => setReaction(requireDb(), requireActor(event), 'post', getRouterParam(event, 'id'), true))
