import { getPublicProfile } from '../../../modules/identity/profiles'

/** GET /api/v1/profiles/:handle — 공개 DTO(이메일·내부 ID 없음). 로그인 불필요. */
export default defineApiHandler((event) => getPublicProfile(requireDb(), getRouterParam(event, 'handle') ?? ''))
