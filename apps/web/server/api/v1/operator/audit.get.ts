import { listAudit } from '../../../modules/moderation/operator'

/** GET /api/v1/operator/audit?target=<id> — 운영자만. 그 대상·조치·공개 id의 감사 기록(최근 200, 본문·메모 글 없음). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return listAudit(requireDb(), actor, getQuery(event))
})
