import { createBlock } from '../../../modules/social/blocks'

/**
 * POST /api/v1/blocks {handle, as, scope?: origin_persona | all_personas, confirmLinkInference?} — 페르소나 페이지에서 차단(S-04, 201).
 * 대상의 사용자 id는 응답에 없습니다. all_personas + 연결 비공개면 확인 없이 422 `confirmLinkInference: required`. 상대에게 알리지 않습니다.
 */
export default defineApiHandler(async (event) => {
  const block = await createBlock(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return block
})
