import { revokeCourseCurator } from '../../../../../../modules/curators/assignments'

/** DELETE /api/v1/operator/courses/:id/curators/:userId — 운영자만(E-03). 해제(행은 남김, 다음 요청부터 권한 없음). 큐레이터가 아니면 404. 감사 id만. */
export default defineApiHandler((event) => revokeCourseCurator(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'userId')))
