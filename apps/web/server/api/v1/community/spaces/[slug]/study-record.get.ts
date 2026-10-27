import { getStudyRecord } from '../../../../../modules/community/study-records'

/** GET /api/v1/community/spaces/:slug/study-record — 스터디 기록 상태(방을 읽을 수 있는 사람, 아니면 404). 과제 id는 기록 멤버에게만. */
export default defineApiHandler(async (event) => getStudyRecord(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
