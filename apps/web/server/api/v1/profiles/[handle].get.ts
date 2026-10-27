import { getPublicProfile } from '../../../modules/identity/profiles'

/** GET /api/v1/profiles/:handle — 공개 DTO(이메일·내부 ID 없음). 로그인 불필요. 실명·표시명 페르소나 handle 모두(S-01), 연결이 꺼져 있으면 상대 페르소나 정보 없음. */
export default defineApiHandler((event) => getPublicProfile(requireDb(), getRouterParam(event, 'handle') ?? ''))
