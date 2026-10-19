import { getMe } from '../../../modules/identity/profiles'

/** GET /api/v1/me — 본인 전용 DTO(이메일 포함). */
export default defineApiHandler((event) => getMe(requireDb(), requireActor(event)))
