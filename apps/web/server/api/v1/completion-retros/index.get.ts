import { listCompletionRetros } from '../../../modules/institutions/completion-retros'

/**
 * GET /api/v1/completion-retros?institution=&kind=&before= — 수료 회고 목록(A-06, P2 institutions 플래그, 꺼짐 404). 로그인 + active 기관 인증
 * (또는 운영자)만 읽고, 아니면 eligible false + 빈 목록. 공개 아카이브·검색에는 나오지 않습니다.
 */
export default defineApiHandler(async (event) => listCompletionRetros(requireDb(), requireActor(event), getQuery(event)))
