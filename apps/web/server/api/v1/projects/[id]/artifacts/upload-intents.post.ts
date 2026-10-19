import { createUploadIntent } from '../../../../../modules/artifacts/artifacts'

/**
 * POST /api/v1/projects/:id/artifacts/upload-intents {fileName, declaredType, byteSize, clientId?, artifactId?}
 * — active owner/editor. 15분짜리 업로드 의도를 만들어 201(같은 clientId 재전송은 200).
 * 형식·확장자·파일 한도(20MB)·사용자 한도(500MB) 위반은 422 필드 코드.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const { intent, created } = await createUploadIntent(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, created ? 201 : 200)
  return intent
})
