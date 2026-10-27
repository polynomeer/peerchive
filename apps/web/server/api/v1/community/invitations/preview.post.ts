import { previewSpaceInvitation } from '../../../../modules/community/invitations'

/**
 * POST /api/v1/community/invitations/preview {token} — 초대받은 방 소개와 수락 가능 여부. 410.
 * 토큰을 URL(서버 접근 로그·Referer)에 싣지 않도록 본문으로 받습니다(과제 초대와 같은 판단).
 */
export default defineApiHandler(async (event) => {
  const body = (await readJsonBody(event)) as { token?: unknown }
  return previewSpaceInvitation(requireDb(), requireActor(event), body?.token)
})
