import { createInstitution } from '../../../../modules/institutions/institutions'

/** POST /api/v1/operator/institutions {name, kind} — 운영자만, 대학이 아닌 기관 만들기(I-01). 201. 플래그가 꺼져 있으면 404. */
export default defineApiHandler(async (event) => {
  const result = await createInstitution(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
