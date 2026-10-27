import { listMySpaces } from '../../../../modules/community/spaces'

/** GET /api/v1/community/spaces/mine — 내 공간(active 멤버인 방 + 내 학교 공식 페이지)·승인 대기·방 만들기 가능 여부(C-02). */
export default defineApiHandler(async (event) => listMySpaces(requireDb(), requireActor(event)))
