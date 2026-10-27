import type { MySignalDto, SignalKind } from '~~/shared/types/api'

export type SignalTarget =
  | { kind: 'stuck_item'; slug: string; itemKey: string }
  | { kind: 'senior_note'; noteId: string }
  | { kind: 'course_qa'; qaId: string }

export const signalKey = (target: SignalTarget, kind: SignalKind) =>
  target.kind === 'stuck_item'
    ? `s:${target.slug}:${target.itemKey}:${kind}`
    : target.kind === 'senior_note'
      ? `n:${target.noteId}:${kind}`
      : `q:${target.qaId}:${kind}`

/**
 * 공개 페이지(과목 허브)의 "내 신호" 상태(T-13). SSR에서는 로그인 상태를 읽지 않으므로(공개 페이지 규칙) 화면이 뜬 뒤
 * 클라이언트에서만 로그인 여부와 내 신호를 불러옵니다. 로그인하지 않았으면 loggedIn=false.
 */
export function useMySignals() {
  const loggedIn = useState<boolean | null>('signals-logged-in', () => null)
  const mine = useState<string[]>('signals-mine', () => [])

  async function load(): Promise<void> {
    if (import.meta.server) return
    const me = await useAuth().ensure()
    loggedIn.value = !!me
    if (!me) return
    try {
      const rows = await $fetch<MySignalDto[]>('/api/v1/me/signals')
      mine.value = rows.map((r) =>
        r.target === 'stuck_item'
          ? signalKey({ kind: 'stuck_item', slug: r.slug, itemKey: r.itemKey }, r.kind)
          : r.target === 'senior_note'
            ? signalKey({ kind: 'senior_note', noteId: r.noteId }, r.kind)
            : signalKey({ kind: 'course_qa', qaId: r.qaId }, r.kind),
      )
    } catch {
      mine.value = []
    }
  }

  function setMine(key: string, on: boolean) {
    const set = new Set(mine.value)
    if (on) set.add(key)
    else set.delete(key)
    mine.value = [...set]
  }

  return { loggedIn, mine, load, setMine }
}
