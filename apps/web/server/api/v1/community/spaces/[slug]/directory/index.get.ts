import { listDirectory } from '../../../../../../modules/community/member-directory'

/**
 * GET /api/v1/community/spaces/:slug/directory?page=&pageSize= — 동문회·OB 방 멤버 명부 한 쪽(A-03, 최대 20개). 방 멤버만(404).
 * 쪽을 볼 때마다 rate limit(10분에 20쪽, 429). 내보내기(CSV·PDF)·일괄 조회 경로는 없습니다(ADR 0040).
 */
export default defineApiHandler(async (event) => listDirectory(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getQuery(event)))
