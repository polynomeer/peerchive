import { listCaseStudySources } from '../../../modules/portfolio/case-studies'

/** GET /api/v1/me/case-study-sources — 내가 팀원으로 들어 있는 지금 게시 중인 공개 사례(케이스 스터디를 만들 수 있는 것). */
export default defineApiHandler((event) => listCaseStudySources(requireDb(), requireActor(event)))
