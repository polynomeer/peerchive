/**
 * 빌드 로그 타임라인 밖(할 일 섹션의 로그 전환, T-07)에서 로그가 생겼음을 알리는 프로젝트별 신호.
 * BuildLog가 이 값을 지켜보다 바뀌면 목록을 다시 불러옵니다.
 */
export function useLogsChanged(projectId: string) {
  const tick = useState<number>(`logs-changed:${projectId}`, () => 0)
  return { tick, notify: () => (tick.value += 1) }
}
