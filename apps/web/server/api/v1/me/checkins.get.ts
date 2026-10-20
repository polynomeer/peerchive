import { myCheckinStatus } from '../../../modules/checkins/checkins'

/** GET /api/v1/me/checkins — 이번 주 체크인 제출 여부(내가 active 멤버인 과제별). */
export default defineApiHandler((event) => myCheckinStatus(requireDb(), requireActor(event)))
