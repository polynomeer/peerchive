import { getPublicProfile } from '../../../modules/identity/profiles'
import { getProfileProjects } from '../../../modules/social/visibility'

/**
 * GET /api/v1/profiles/:handle — 공개 DTO(이메일·내부 ID 없음). 로그인 불필요. 실명·표시명 페르소나 handle 모두(S-01), 연결이 꺼져 있으면 상대 페르소나 정보 없음.
 * S-03: 세션이 있으면 읽어 과제 수행 목록(`projects`)을 보는 사람 기준(`canViewPersonaItem`: 로그인·같은 기관·본인)으로 싣습니다. 볼 수 없으면 null.
 * 보는 사람마다 다른 응답이라 어디에도 저장하지 않습니다(private, no-store).
 */
export default defineApiHandler(async (event) => {
  const db = requireDb()
  const handle = getRouterParam(event, 'handle') ?? ''
  const auth = event.context.auth
  setResponseHeader(event, 'cache-control', 'private, no-store')
  const profile = await getPublicProfile(db, handle)
  return { ...profile, ...(await getProfileProjects(db, auth ? { userId: auth.user.id } : null, handle)) }
})
