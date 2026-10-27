import { removeBlock } from '../../../modules/social/blocks'

/** DELETE /api/v1/blocks/:id — 내 차단 해제(S-04). 남의 것·없는 id 404. */
export default defineApiHandler((event) => removeBlock(requireDb(), requireActor(event), getRouterParam(event, 'id')))
