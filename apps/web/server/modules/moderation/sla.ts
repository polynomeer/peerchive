/**
 * 신고 처리 기한 설정(C-10, ADR 0027). 환경 변수 PEERCHIVE_REPORT_SLA_AUTO_HIDDEN_HOURS(기본 24)·PEERCHIVE_REPORT_SLA_HOURS(기본 72)를
 * 요청마다 읽습니다. 판정 규칙은 @peerchive/domain reportGroupSla입니다.
 */
import { reportSlaTargets, type ReportSlaTargets } from '@peerchive/domain'

let slaOverride: ReportSlaTargets | null = null

/** 테스트용: 환경 변수 대신 쓸 처리 기한(null이면 process.env). */
export function setReportSlaTargetsForTesting(targets: ReportSlaTargets | null): void {
  slaOverride = targets
}

export function currentReportSlaTargets(): ReportSlaTargets {
  if (slaOverride) return slaOverride
  return reportSlaTargets((globalThis.process?.env ?? {}) as Record<string, string | undefined>)
}
