import { lookupPersonaOwner } from '../../../../modules/moderation/personas'

/**
 * POST /api/v1/operator/persona-owner-lookups {reportId, reason} — 페르소나·프로필 글·소셜 링크 신고의 주인 확인(S-07, ADR 0036). 운영자만(403 operator_only).
 * 사유 필수(422), 다른 종류의 신고 422 `reportId: not_persona_target`, 없는 신고 404, 대상이 지워짐 409 `target_unavailable`, 429.
 * 201 + 주인(계정 id·상태·페르소나 전부·연결 공개 여부·걸린 조치 수). 확인 기록(사유) + 감사 persona.owner_lookup(id만)을 같은 트랜잭션에 남깁니다.
 */
export default defineApiHandler(async (event) => {
  const result = await lookupPersonaOwner(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
