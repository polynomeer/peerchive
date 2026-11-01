import { createTopic } from '../../../../../modules/community/topics'

/** POST /api/v1/operator/community/topics {name, description?, category} — 토픽 만들기(운영자만, A-05, 플래그 꺼짐 404). 201. 409 topic_exists. */
export default defineApiHandler(async (event) => {
  const result = await createTopic(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
