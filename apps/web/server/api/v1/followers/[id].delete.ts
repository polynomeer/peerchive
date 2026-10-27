import { removeFollower } from '../../../modules/social/follows'

/**
 * DELETE /api/v1/followers/:id — 팔로워 삭제(S-04, 팔로우 행 id, 행 삭제, 상대에게 알리지 않음). 남의 것·없는 id 404.
 * 다른 사람의 페르소나 id를 응답에 싣지 않으려고 설계 초안의 `:personaId` 대신 팔로우 행 id를 씁니다(ADR 0033).
 */
export default defineApiHandler((event) => removeFollower(requireDb(), requireActor(event), getRouterParam(event, 'id')))
