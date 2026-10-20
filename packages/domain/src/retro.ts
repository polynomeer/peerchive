/**
 * 사후 작성 모드 규칙 (PROOFU_EVOLUTION_PLAN §6.7, SYSTEM_DESIGN §6.3 Project.retro_mode, DELIVERY_PLAN 시나리오 G, T-07).
 *
 * - 이미 끝난 과제를 거꾸로 정리하는 모드입니다. 이 모드에서 만든 로그·마일스톤·스냅샷은 만들 때 `사후 작성`으로 고정되고,
 *   나중에 모드를 꺼도 그 표시는 지워지지 않습니다(진행 중 기록보다 신뢰 표시가 낮다는 점을 숨기지 않음).
 * - 모드 변경은 owner만. 켜기·끄기 모두 허용합니다: 표시가 항목별로 고정되므로, 끈 뒤 새로 쓴 기록만 진행 중 기록이 됩니다.
 * - 로그 출처(source): 사후 작성 모드에서 직접 쓴 로그는 `retro`, 할 일에서 전환한 로그는 모드와 무관하게 `task`.
 *   사후 작성 여부는 source와 별개인 retrospective 표시로 남깁니다(할 일 전환 로그도 사후 작성일 수 있음).
 */
import { type Membership, type ProjectRef, type Viewer, canReadProjectWorkspace } from './permissions'

/** 로그가 어디서 왔는지(SYSTEM_DESIGN §6.3 LogEntry.source 중 이 앱이 만드는 값). */
export type LogOrigin = 'web' | 'task'

/** 사후 작성 모드 켜기·끄기: active owner만. */
export function canChangeRetroMode(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && membership!.role === 'owner'
}

/** 새 로그의 source와 사후 작성 표시. 만들 때의 프로젝트 모드로 정하고 이후 바꾸지 않습니다. */
export function logSourceFor(
  retroMode: boolean,
  origin: LogOrigin,
): { source: 'web' | 'task' | 'retro'; retrospective: boolean } {
  if (origin === 'task') return { source: 'task', retrospective: retroMode }
  return retroMode ? { source: 'retro', retrospective: true } : { source: 'web', retrospective: false }
}

/**
 * 저장된 로그 행의 사후 작성 여부. source가 `retro`이거나 만들 때 사후 작성 모드였으면(retrospective) 참입니다.
 * 공개 DTO(T-11/T-12)도 이 함수로 표시를 정해야 합니다.
 */
export function isRetrospectiveLog(entry: { source: string; retrospective: boolean }): boolean {
  return entry.source === 'retro' || entry.retrospective
}
