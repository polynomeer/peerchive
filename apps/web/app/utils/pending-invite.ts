/**
 * 로그인 전에 연 초대 링크를 로그인 후 이어서 처리하기 위한 임시 저장(이 브라우저에만).
 * 매직링크가 새 탭에서 열릴 수 있어 localStorage를 씁니다. 사용 즉시 지웁니다.
 */
const KEY = 'peerchive:pending-invite'

export function savePendingInvite(token: string): void {
  try {
    localStorage.setItem(KEY, token)
  } catch {
    // 저장소를 쓸 수 없으면 사용자가 링크를 다시 열면 됩니다.
  }
}

export function takePendingInvite(): string | null {
  try {
    const token = localStorage.getItem(KEY)
    localStorage.removeItem(KEY)
    return token
  } catch {
    return null
  }
}
