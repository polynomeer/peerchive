import { getHubOpeningProgress } from '../../../../modules/course-hub/staged-opening'

/** GET /api/v1/operator/course-hubs/opening — 운영자만(403 operator_only). 과목별 공개 사례·선배 노트 수와 개방 기준(E-02, 집계만). */
export default defineApiHandler((event) => getHubOpeningProgress(requireDb(), requireActor(event)))
