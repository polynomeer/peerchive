import { completeUpload } from '../../../../modules/artifacts/artifacts'

/**
 * POST /api/v1/uploads/:intentId/complete — 버전을 검사 대기(pending)로 만들고 검사 작업을 남깁니다.
 * 새로 만들면 201, 같은 의도 재완료·같은 내용(sha256)의 기존 버전이면 200. 내용을 아직 안 받았으면 409 `not_uploaded`.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const { created, ...result } = await completeUpload(requireDb(), useObjectStorage(), actor, getRouterParam(event, 'intentId'))
  setResponseStatus(event, created ? 201 : 200)
  return result
})
