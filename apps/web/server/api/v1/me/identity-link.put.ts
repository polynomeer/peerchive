import { setIdentityLink } from '../../../modules/social/personas'

/**
 * PUT /api/v1/me/identity-link {visible: boolean} — 표시명 ↔ 실명 연결 표시 켜기·끄기(S-01, ADR 0028). 200 + 내 페르소나.
 * 표시명 페르소나가 없으면 409 `no_display_persona`. 감사 기록에는 플래그만 남습니다. 공개 프로필은 다음 요청부터 바뀝니다.
 */
export default defineApiHandler(async (event) => setIdentityLink(requireDb(), requireActor(event), await readJsonBody(event)))
