import { getPublicationState } from '../../../../modules/publication/candidates'

/** GET /api/v1/projects/:id/publication — 공개 준비 화면(멤버): 공개 상태·열린(없으면 마지막) 후보·선택지·엠바고. 비멤버 404. */
export default defineApiHandler(async (event) =>
  getPublicationState(requireDb(), requireActor(event), getRouterParam(event, 'id')),
)
