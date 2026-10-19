import { requestAccountDeletion } from '../../../modules/identity/account'

/**
 * POST /api/v1/me/deletion-request — 계정을 deleted 상태로 바꾸고 모든 세션을 끊습니다.
 * 실제 데이터 삭제(purge)는 별도 작업입니다(범위 밖).
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  await requestAccountDeletion(requireDb(), actor)
  clearSessionCookie(event)
  setResponseStatus(event, 202)
  return { status: 'deletion_requested' as const }
})
