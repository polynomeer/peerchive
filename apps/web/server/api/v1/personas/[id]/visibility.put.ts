import { setVisibility } from '../../../../modules/social/visibility'

/**
 * PUT /api/v1/personas/:id/visibility {items: {project_list|posts|notes_and_studies|follow_lists: audience}} — 항목별 공개 범위(S-03, 본인만).
 * 남의 것·없는 id 404. 공개 사례·케이스 스터디는 항목이 아니라 422(`publication_procedure`, 공개 절차 경유), follow_lists는 public·private만,
 * 표시명 페르소나의 project_list는 private만(`real_persona_only`).
 */
export default defineApiHandler(async (event) =>
  setVisibility(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
