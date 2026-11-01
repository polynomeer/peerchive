import { getP2Metrics } from '../../../../../modules/community/ops-metrics'

/** GET /api/v1/operator/metrics/community/p2?from=&to= — §6.2 P2 졸업생·토픽·기관 지표(A-07). 운영자만, 꺼진 영역은 null, 5 미만 null. */
export default defineApiHandler((event) => getP2Metrics(requireDb(), requireActor(event), getQuery(event)))
