import { upsertProfile } from '../../../modules/identity/profiles'

/** PATCH /api/v1/me/profile — 프로필 생성(handle·displayName 필수) 또는 부분 수정. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return upsertProfile(requireDb(), actor, await readJsonBody(event))
})
