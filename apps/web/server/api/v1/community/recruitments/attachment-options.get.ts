import { attachmentOptions } from '../../../../modules/community/recruitments'

/** GET /api/v1/community/recruitments/attachment-options — 지원서에 붙일 수 있는 내 공개 프로필·내가 팀원인 공개 사례. 200. */
export default defineApiHandler(async (event) => attachmentOptions(requireDb(), requireActor(event)))
