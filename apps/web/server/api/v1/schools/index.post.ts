import { createSchool } from '../../../modules/catalog/catalog'

/** POST /api/v1/schools {name, confirmNew?} — 201. 같은 이름 409 already_exists, 비슷한 이름 409 similar_exists, 한도 429. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const school = await createSchool(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, 201)
  return school
})
