/**
 * GitHub에서 돌아오는 화면 이동 경로(setup·OAuth 콜백)의 오류 처리(E-11). JSON 대신 화면으로 보내고 짧은 이유 코드만 주소에 싣습니다
 * (개인정보·토큰·GitHub 응답 없음). 과제를 알 수 있으면 그 과제 화면, 아니면 계정 화면(GitHub 연결 칸)으로 보냅니다.
 */
import { ServiceError } from '../errors'
import { GithubApiError } from './client'
import { GithubFlowError, identityRedirect, projectRedirect } from './connect'

export function githubRedirectError(error: unknown): string {
  const projectId = error instanceof GithubFlowError ? error.projectId : null
  const cause = error instanceof GithubFlowError ? error.original : error
  let reason: string
  if (cause instanceof ServiceError) reason = cause.reason && /^[a-z_]+$/.test(cause.reason) ? cause.reason : 'failed'
  else if (cause instanceof GithubApiError) {
    console.warn(`[github] ${cause.message}`)
    reason = 'github_unavailable'
  } else throw cause
  return projectId ? projectRedirect(projectId, `error:${reason}`) : identityRedirect(`error:${reason}`)
}
