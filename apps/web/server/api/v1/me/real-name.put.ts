import { updateRealName } from '../../../modules/identity/profiles'

/** PUT /api/v1/me/real-name {realName: string | null} — 선택 실명(C-03, 실명 방식 커뮤니티 글에서만 보임). 422 realName too_long|invalid. */
export default defineApiHandler(async (event) => updateRealName(requireDb(), requireActor(event), await readJsonBody(event)))
