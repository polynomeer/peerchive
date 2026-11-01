import { searchInstitutions } from '../../../modules/institutions/institutions'

/** GET /api/v1/institutions?q=&kind= — 대학이 아닌 기관 검색(I-01, ADR 0037). 로그인 필요, P2 플래그 institutions가 꺼져 있으면 404. */
export default defineApiHandler((event) => searchInstitutions(requireDb(), requireActor(event), getQuery(event)))
