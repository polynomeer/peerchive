/**
 * GitHub 연결 화면 문구(E-11, ADR 0056). 서버가 이동 주소(`?github=`)에 싣는 짧은 결과·이유 코드를 사람이 읽는 문장으로 바꿉니다.
 */
const GITHUB_RESULT_TEXT: Record<string, { kind: 'ok' | 'error'; text: string }> = {
  linked: { kind: 'ok', text: 'GitHub 계정을 연결했습니다.' },
  select: { kind: 'ok', text: 'GitHub에서 확인을 마쳤습니다. 이 과제에 연결할 저장소를 고르세요.' },
  requested: { kind: 'ok', text: '조직 관리자에게 설치 승인을 요청했습니다. 승인된 뒤 다시 "GitHub 연결"을 누르세요.' },
  no_repositories: { kind: 'error', text: '연결할 수 있는 저장소가 없습니다. 설치할 때 이 과제의 저장소를 골랐는지 확인하세요.' },
  'error:github_state_invalid': { kind: 'error', text: '연결 요청이 만료되었거나 이미 사용되었습니다. 처음부터 다시 시도하세요.' },
  'error:github_account_in_use': { kind: 'error', text: '이 GitHub 계정은 이미 다른 Peerchive 계정에 연결되어 있습니다.' },
  'error:installation_not_accessible': { kind: 'error', text: '이 GitHub 설치에 접근할 수 없는 계정입니다. 설치한 GitHub 계정으로 다시 시도하세요.' },
  'error:github_unavailable': { kind: 'error', text: 'GitHub에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.' },
}

export function githubResultNotice(value: unknown): { kind: 'ok' | 'error'; text: string } | null {
  if (typeof value !== 'string' || !value) return null
  return GITHUB_RESULT_TEXT[value] ?? (value.startsWith('error:') ? { kind: 'error', text: 'GitHub 연결을 마치지 못했습니다. 다시 시도하세요.' } : null)
}

export function githubErrorText(code: string | undefined): string {
  switch (code) {
    case 'already_linked':
      return '이미 저장소가 연결되어 있습니다. 먼저 연결을 해제하세요.'
    case 'repo_in_use':
      return '이 저장소는 다른 과제에 연결되어 있습니다.'
    case 'github_selection_expired':
      return '저장소 고르기 시간이 지났습니다. "GitHub 연결"을 다시 누르세요.'
    case 'installation_not_accessible':
      return '이 저장소가 더 이상 GitHub App 설치에 들어 있지 않습니다.'
    default:
      return '처리하지 못했습니다. 다시 시도하세요.'
  }
}
