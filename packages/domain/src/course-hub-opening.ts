/**
 * 과목 허브 단계적 개방 (E-02, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4 E-02, ADR 0047).
 *
 * - 플래그 `PEERCHIVE_FEATURE_HUB_STAGED_OPENING`(기본 꺼짐, features.ts)이 꺼져 있으면 모든 과목 허브는 지금처럼 열려 있습니다.
 * - 켜져 있으면 과목(정본 + 병합된 과목)의 **공개 사례 + 선배 노트** 합계가 기준(`PEERCHIVE_HUB_OPEN_THRESHOLD`, 기본 3) 이상일 때만
 *   허브 모음 페이지를 보여 주고, 그 전에는 "준비 중"입니다. 막힘 Q&A·체크인 통계·태그는 세지 않습니다(§8.6은 사례·노트만 셈).
 * - 판정은 요청마다 그 순간의 값으로 합니다(저장하지 않음). 기준에 이르면 다음 요청부터 열리고, 철회·숨김으로 기준 밑으로 내려가면 다시 "준비 중"입니다.
 *
 * 런타임 의존성 없음.
 */

export const HUB_OPEN_THRESHOLD_ENV = 'PEERCHIVE_HUB_OPEN_THRESHOLD'
/** 초기안(§8.6): 공개 사례 + 선배 노트 합계 3개. pilot에서 확정합니다. */
export const HUB_OPEN_THRESHOLD_DEFAULT = 3
export const HUB_OPEN_THRESHOLD_MAX = 100

/** 기준값 해석: 1~100의 정수만, 그 밖(빈 값·소수·0·음수·글자)은 기본값 3. */
export function parseHubOpenThreshold(raw: string | undefined): number {
  const value = raw?.trim() ?? ''
  if (!/^\d+$/.test(value)) return HUB_OPEN_THRESHOLD_DEFAULT
  const n = Number(value)
  return n >= 1 && n <= HUB_OPEN_THRESHOLD_MAX ? n : HUB_OPEN_THRESHOLD_DEFAULT
}

export interface HubContentCount {
  /** 지금 게시 중인 공개 사례(엠바고 없음) 수. */
  cases: number
  /** 게시된(숨김·철회·초안 아님) 선배 노트 수. */
  notes: number
}

export type HubOpeningStatus = 'open' | 'preparing'

/** 허브가 열렸는지. 플래그가 꺼져 있으면 항상 open. */
export function hubOpeningStatus(count: HubContentCount, threshold: number, stagedOpening: boolean): HubOpeningStatus {
  if (!stagedOpening) return 'open'
  return count.cases + count.notes >= threshold ? 'open' : 'preparing'
}
