import { listRecruitments } from '../../../../modules/community/recruitments'

/**
 * GET /api/v1/community/recruitments?space=:slug | ?course=:id [&kind=team|study] — 모집 게시판(C-07).
 * 공간은 읽을 수 있는 사람, 과목은 그 학교 인증 사용자만(아니면 404). 200 RecruitmentListDto. 422(둘 다·둘 다 없음).
 */
export default defineApiHandler(async (event) => listRecruitments(requireDb(), requireActor(event), getQuery(event)))
