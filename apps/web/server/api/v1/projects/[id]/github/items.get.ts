import { listGithubCandidates } from '../../../../../modules/github/items'

/** GET /api/v1/projects/:id/github/items[?mine=1] — 멤버별 커밋·PR 근거 후보(멤버만, 최근 30개씩, mine이면 본인만). 자동 확정·집계 없음(E-11). */
export default defineApiHandler((event) => {
  requireGithubContext()
  const mine = getQuery(event).mine === '1'
  return listGithubCandidates(requireDb(), requireActor(event), getRouterParam(event, 'id'), { mine })
})
