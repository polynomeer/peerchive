import { courseTeamFindingEntry } from '../../../../modules/community/recruitments'

/**
 * GET /api/v1/community/recruitments/course-entry?courseId= — 과목 허브의 "이 과목 팀원 찾기" 링크를 보일지(그 학교 인증 + 팀원 찾기 켜짐).
 * 로그인한 화면만 따로 묻습니다(공개 과목 허브 응답에는 없음). 200 {available}, 404.
 */
export default defineApiHandler(async (event) => courseTeamFindingEntry(requireDb(), requireActor(event), getQuery(event).courseId))
