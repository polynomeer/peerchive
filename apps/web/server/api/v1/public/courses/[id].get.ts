import { createPublicCourseHubHandler } from '../../../../modules/course-hub/public-http'

/**
 * GET /api/v1/public/courses/:id — 익명 과목 허브(로그인 불필요, 쿠키 없음). 병합된 과목 id면 정본 허브(course.id가 정본).
 * 지금 게시 중인 release 스냅샷·게시된 선배 노트·n≥5 체크인 분포만. 없는 과목 404, 운영 스위치 503(ADR 0013).
 */
export default createPublicCourseHubHandler({ getDb: requireDb })
