import { getMyVisibility } from '../../../../modules/social/visibility'

/** GET /api/v1/personas/:id/visibility — 내 페르소나의 항목별 공개 범위(S-03, 본인만). 저장하지 않은 항목은 기본값. 남의 것·없는 id는 404. */
export default defineApiHandler((event) => getMyVisibility(requireDb(), requireActor(event), getRouterParam(event, 'id')))
