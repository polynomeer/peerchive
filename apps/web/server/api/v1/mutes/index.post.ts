import { createMute } from '../../../modules/social/blocks'

/** POST /api/v1/mutes {handle} — 뮤트(S-04, 201). 팔로우 피드·알림(S-05)에서만 빠지고 상대에게 알리지 않습니다. */
export default defineApiHandler(async (event) => {
  const mute = await createMute(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return mute
})
