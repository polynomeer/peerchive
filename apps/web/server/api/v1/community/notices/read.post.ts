import { markCommunityNoticesRead } from '../../../../modules/community/notices'

/** POST /api/v1/community/notices/read {ids: uuid[]} | {all: true} — 내 알림을 읽음으로(C-03). 422(둘 다 없음·둘 다 있음). */
export default defineApiHandler(async (event) => markCommunityNoticesRead(requireDb(), requireActor(event), await readJsonBody(event)))
