import { listMyCuratorProposals } from '../../../../modules/curators/assignments'

/** GET /api/v1/me/curator-proposals — 내게 온 대기 중인 큐레이터 제안(ADR 0060 D-08). */
export default defineApiHandler((event) => listMyCuratorProposals(requireDb(), requireActor(event)))
