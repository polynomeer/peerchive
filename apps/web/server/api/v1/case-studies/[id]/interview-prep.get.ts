import { getInterviewPrep } from '../../../../modules/portfolio/interview-prep'

/** GET /api/v1/case-studies/:id/interview-prep — 작성자만(아니면 404). 면접 준비 팩: 지금 질문 + 비공개 답변 메모·공개 선택 + 보관된 메모(E-06). */
export default defineApiHandler((event) => getInterviewPrep(requireDb(), requireActor(event), getRouterParam(event, 'id')))
