/**
 * 운영 조치로 가린 공개 항목(hide_item) 읽기 (T-15, ADR 0015).
 *
 * 가린 항목은 공개(publication) 전체에 적용되고(스냅샷 키는 공개마다 안정), 공개 읽기 경로는 요청마다 이 표를 읽어 **같은 요청 안에서**
 * 스냅샷 사본에서 뺍니다(@peerchive/domain redactHiddenItems). 저장된 release 스냅샷은 바꾸지 않으며 worker를 기다리지 않습니다.
 * 쓰는 곳: 공개 사례·파일(loadServedRelease), 과목 허브(servableReleasesForCourse), 검색(SQL 조건 hiddenStuckSql), 신호·포크·케이스 초안
 * (loadServedRelease), 케이스 스터디 공개 보기(인용한 문장 가림).
 */
import { type HiddenItemRef, redactHiddenItems } from '@peerchive/domain'
import { and, inArray, isNull, releaseHiddenItems, searchDocuments, sql, type DbExecutor, type SQL } from '@peerchive/db'
import type { PublicSnapshot } from '../../../shared/types/api'

/** 공개별 지금 가린 항목. */
export async function loadHiddenItems(db: DbExecutor, publicationIds: readonly string[]): Promise<Map<string, HiddenItemRef[]>> {
  const out = new Map<string, HiddenItemRef[]>()
  const ids = [...new Set(publicationIds)]
  if (ids.length === 0) return out
  const rows = await db
    .select({ publicationId: releaseHiddenItems.publicationId, kind: releaseHiddenItems.itemKind, key: releaseHiddenItems.itemKey })
    .from(releaseHiddenItems)
    .where(and(inArray(releaseHiddenItems.publicationId, ids), isNull(releaseHiddenItems.liftedAt)))
  for (const r of rows) out.set(r.publicationId, [...(out.get(r.publicationId) ?? []), { kind: r.kind, key: r.key }])
  return out
}

/** 공개 읽기용 스냅샷 사본(가린 항목 제외)과 자리 표시. */
export function redactSnapshot(snapshot: PublicSnapshot, hidden: readonly HiddenItemRef[]) {
  return redactHiddenItems(snapshot, hidden)
}

/** 검색 문서 중 가린 막힘 카드(로그 키)인지 — 검색 쿼리의 WHERE에 `not (...)`로 씁니다(search_documents가 FROM에 있어야 함). */
export function hiddenStuckSql(): SQL {
  return sql`(${searchDocuments.kind} = 'stuck' and exists (select 1 from ${releaseHiddenItems} h
    where h.publication_id = ${searchDocuments.publicationId} and h.item_kind = 'log' and h.item_key = ${searchDocuments.itemKey} and h.lifted_at is null))`
}
