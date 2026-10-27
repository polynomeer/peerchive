import { removeMute } from '../../../modules/social/blocks'

/** DELETE /api/v1/mutes/:id — 뮤트 해제(S-04). 남의 것·없는 id 404. */
export default defineApiHandler((event) => removeMute(requireDb(), requireActor(event), getRouterParam(event, 'id')))
