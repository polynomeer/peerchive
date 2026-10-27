import { updatePersona } from '../../../modules/social/personas'

/**
 * PATCH /api/v1/personas/:id {handle?, displayName?, 프로필 필드?, accountPrivacy?, showFollowerCount?} — 내 페르소나 수정(S-01). 남의 것·없는 id는 404.
 * 실명 페르소나의 이름은 계정 표시 이름이라 422 `displayName: not_editable`. handle 겹침 422 `handle: taken`.
 */
export default defineApiHandler(async (event) =>
  updatePersona(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
