import { getContribution } from '../../../../modules/contribution/ledger'

/**
 * GET /api/v1/projects/:id/contribution?from=YYYY-MM-DD&to=YYYY-MM-DD — 멤버(읽기 전용 포함). 기간 기여 장부.
 * 기본은 이번 주(월~일, Asia/Seoul). 이름순, 점수·순위 없음. 기간 오류 422.
 */
export default defineApiHandler((event) =>
  getContribution(requireDb(), requireActor(event), getRouterParam(event, 'id'), getQuery(event)),
)
