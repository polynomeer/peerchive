import { grantInstitutionStaff } from '../../../../../../modules/institutions/staff'

/** POST /api/v1/operator/institutions/:id/staff {userId} — 운영자만(I-02). 201 + 운영진 목록. 감사 id만. 플래그 꺼짐 404. */
export default defineApiHandler(async (event) => {
  const result = await grantInstitutionStaff(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
