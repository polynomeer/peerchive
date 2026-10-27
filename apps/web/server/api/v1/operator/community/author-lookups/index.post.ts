import { lookupAuthor } from '../../../../../modules/community/moderation'

/**
 * POST /api/v1/operator/community/author-lookups {targetType: post|comment, targetId, reason, reportId?|requestId?} — 운영자만(403 operator_only).
 * 사유 필수(422), 근거가 다른 대상이면 422 mismatch, 404, 429(시간당 20·하루 60). 201 + 작성자(내부 id·핸들·상태, 이메일 없음).
 * 조회 기록(사유) + 감사 community.author_lookup(id만)을 같은 트랜잭션에 남깁니다(C-06).
 */
export default defineApiHandler(async (event) => {
  const result = await lookupAuthor(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
