import { forkPublication } from '../../../../../modules/course-hub/fork'

/**
 * POST /api/v1/public/publications/:slug/fork — 로그인 필수(401). 지금 공개인 사례의 계획(마일스톤·참고 링크)만 복사한
 * 새 비공개 과제를 만듭니다. 처음이면 201, 이미 포크했으면 기존 프로젝트로 200. 공개가 아니면 404, 한도 초과 429(ADR 0013).
 * 이 경로는 공개 접두어 아래의 쓰기라 세션을 읽고 CSRF 검사를 받습니다.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await forkPublication(requireDb(), actor, getRouterParam(event, 'slug'))
  if (result.created) setResponseStatus(event, 201)
  return result
})
