import { saveMyCheckin } from '../../../../../modules/checkins/checkins'

/**
 * PUT /api/v1/projects/:id/checkins/me {week?, timeBucket, difficulty, note?, shareForStats?, skipReasons?, promote?: {tag}}
 * — active 멤버. 처음이면 201, 다시 내면 덮어쓰고 200. promote는 owner/editor만(아니면 403).
 */
export default defineApiHandler(async (event) => {
  const { created, ...result } = await saveMyCheckin(
    requireDb(),
    requireActor(event),
    getRouterParam(event, 'id'),
    await readJsonBody(event),
  )
  setResponseStatus(event, created ? 201 : 200)
  return result
})
