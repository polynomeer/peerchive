import { setCuratorPortfolioDisplay } from '../../../../modules/curators/portfolio'

/** PATCH /api/v1/me/curated-courses/:id {showInPortfolio} — 본인만(E-03). 공개 프로필 "후배 기여"에 이 과목을 보일지(기본 꺼짐). 큐레이터가 아니면 404. */
export default defineApiHandler(async (event) => setCuratorPortfolioDisplay(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
