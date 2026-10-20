/**
 * manifest·해시·공개 전 점검 항목 (T-11, ADR 0011).
 *
 * - manifest: 후보가 무엇을 고정했는지(로그·선언 revision, 마일스톤 version과 스냅샷 버전, 파일 버전과 사용 조건, 노출 이름,
 *   제외한 사람) + 스냅샷 전체의 다이제스트. 목록은 id 순으로 정렬해 같은 선택이면 같은 manifest가 됩니다.
 * - manifest_hash = sha256(canonicalJson(manifest)). 스냅샷 다이제스트가 들어 있으므로 공개될 글자 하나만 바뀌어도 해시가 바뀌고,
 *   동의는 그 해시에 묶입니다(SYSTEM_DESIGN §1 불변조건 2).
 * - 점검은 공개될 스냅샷(+ 원래 파일 이름)에만 돌립니다.
 */
import { createHash } from 'node:crypto'
import { type CheckItem, canonicalJson } from '@peerchive/domain'
import type { ExposureMode, PublicSnapshot, UsageTerms } from '../../../shared/types/api'
import type { PublicKeyKind, SelectionAnalysis } from './snapshot'

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 값의 결정적 해시(canonical JSON의 SHA-256, 소문자 hex 64자). */
export const canonicalHash = (value: unknown) => sha256Hex(canonicalJson(value))

/**
 * 공개마다 안정된 키(내부 id를 드러내지 않고, 다른 공개의 키와 연결되지 않음). 팀원 `m_`, 로그 `l_`, 선언 `c_`, 마일스톤 `ms_`.
 * 같은 공개의 다음 후보에서도 같은 항목은 같은 키입니다.
 */
export const publicKeyFor = (publicationId: string, kind: PublicKeyKind, id: string) =>
  `${kind}_${sha256Hex(`peerchive-public-key:${publicationId}:${kind}:${id}`).slice(0, 12)}`

export const memberKeyFor = (publicationId: string, userId: string) => publicKeyFor(publicationId, 'm', userId)

const byId = <T>(key: (item: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)

export interface PublicationManifest {
  format: 'peerchive.publication-manifest'
  schemaVersion: 1
  projectId: string
  publicationId: string
  level: PublicSnapshot['level']
  slug: string
  title: string
  summary: string
  logs: Array<{ id: string; revisionId: string; revisionNo: number }>
  milestones: Array<{ id: string; version: number; snapshotVersionIds: string[] }>
  claims: Array<{ id: string; revisionId: string; revisionNo: number; status: string; confirmedCount: number; disputedCount: number }>
  artifacts: Array<{ artifactVersionId: string; displayName: string; usage: UsageTerms }>
  members: Array<{ userId: string; key: string; mode: ExposureMode; label: string }>
  excludedUserIds: string[]
  contentDigest: string
}

export function buildManifest(input: {
  projectId: string
  publicationId: string
  snapshot: PublicSnapshot
  analysis: SelectionAnalysis
  excludedUserIds: readonly string[]
}): PublicationManifest {
  const { snapshot, analysis } = input
  const claimByKey = new Map(snapshot.claims.map((c) => [c.key, c]))
  const memberByKey = new Map(snapshot.members.map((m) => [m.key, m]))
  return {
    format: 'peerchive.publication-manifest',
    schemaVersion: 1,
    projectId: input.projectId,
    publicationId: input.publicationId,
    level: snapshot.level,
    slug: snapshot.slug,
    title: snapshot.title,
    summary: snapshot.summary,
    logs: [...analysis.included.logs].sort(byId((l) => l.id)),
    milestones: analysis.included.milestones
      .map((m) => ({ ...m, snapshotVersionIds: [...m.snapshotVersionIds].sort() }))
      .sort(byId((m) => m.id)),
    claims: Object.entries(analysis.refs.claims)
      .map(([key, ref]) => {
        const claim = claimByKey.get(key)!
        return {
          id: ref.id,
          revisionId: ref.revisionId,
          revisionNo: claim.revisionNo,
          status: claim.status,
          confirmedCount: claim.confirmedCount,
          disputedCount: claim.disputedCount,
        }
      })
      .sort(byId((c) => c.id)),
    artifacts: snapshot.artifacts
      .map((a) => ({ artifactVersionId: a.artifactVersionId, displayName: a.displayName, usage: a.usage }))
      .sort(byId((a) => a.artifactVersionId)),
    members: Object.entries(analysis.refs.members)
      .map(([key, userId]) => {
        const member = memberByKey.get(key)!
        return { userId, key, mode: member.anonymous ? ('anonymous' as const) : ('name' as const), label: member.label }
      })
      .sort(byId((m) => m.userId)),
    excludedUserIds: [...new Set(input.excludedUserIds)].sort(),
    contentDigest: canonicalHash(snapshot),
  }
}

/** 공개 전 점검에 넘길 항목: 공개될 글·링크·파일 이름(+ 원래 파일 이름). */
export function checkItemsFor(snapshot: PublicSnapshot, rawFileNames: ReadonlyMap<string, string>): CheckItem[] {
  const items: CheckItem[] = [
    { kind: 'text', location: { kind: 'title', field: 'title' }, value: snapshot.title },
    { kind: 'text', location: { kind: 'summary', field: 'summary' }, value: snapshot.summary },
  ]
  for (const m of snapshot.milestones) items.push({ kind: 'text', location: { kind: 'milestone', key: m.key, field: 'title' }, value: m.title })
  for (const log of snapshot.logs) {
    items.push({ kind: 'text', location: { kind: 'log', key: log.key, field: 'body' }, value: log.body })
    for (const [field, value] of Object.entries(log.payload)) {
      if (field === 'attendees') continue
      const values = Array.isArray(value) ? value : [value]
      values.forEach((v, i) => {
        if (typeof v === 'string')
          items.push({
            kind: 'text',
            location: { kind: 'log', key: log.key, field: Array.isArray(value) ? `payload.${field}.${i}` : `payload.${field}` },
            value: v,
          })
      })
    }
    log.links.forEach((link, i) => {
      items.push({ kind: 'url', location: { kind: 'log', key: log.key, field: `links.${i}.url` }, value: link.url })
      if (link.title) items.push({ kind: 'text', location: { kind: 'log', key: log.key, field: `links.${i}.title` }, value: link.title })
    })
  }
  for (const claim of snapshot.claims) items.push({ kind: 'text', location: { kind: 'claim', key: claim.key, field: 'text' }, value: claim.text })
  for (const a of snapshot.artifacts) {
    items.push({ kind: 'file_name', location: { kind: 'artifact', key: a.artifactVersionId, field: 'displayName' }, value: a.displayName })
    const raw = rawFileNames.get(a.artifactVersionId)
    if (raw && raw !== a.displayName)
      items.push({ kind: 'file_name', location: { kind: 'artifact', key: a.artifactVersionId, field: 'fileName' }, value: raw })
  }
  return items
}
