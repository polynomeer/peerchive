import { linkRepository } from '../../../../../modules/github/connect'

/**
 * POST /api/v1/projects/:id/github/link {repoId} — owner만. 확인을 마친 목록에서 저장소 하나를 연결합니다.
 * 목록이 없거나 만료 410 github_selection_expired, 목록에 없음 422, 설치에서 빠짐 403 installation_not_accessible,
 * 이미 연결 409 already_linked, 다른 과제가 연결 중 409 repo_in_use(E-11).
 */
export default defineApiHandler(async (event) => {
  const ctx = requireGithubContext()
  return linkRepository(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event), ctx)
})
