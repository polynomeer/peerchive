import { updateAffiliation } from '../../../../../modules/affiliation/affiliations'

/** PATCH /api/v1/me/affiliations/:id {standing?, departmentLabel?} — 200. 재학생 → 졸업생만(422 standing not_allowed), 409 not_editable, 404. */
export default defineApiHandler(async (event) =>
  updateAffiliation(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
