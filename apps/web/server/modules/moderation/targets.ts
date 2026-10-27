/**
 * 신고 대상 판정 (T-15, ADR 0015).
 *
 * - 신고 대상은 **지금 공개인 것**뿐입니다. 공개 화면이 보여 주는 값(slug·스냅샷 키·노트 id·handle·대표 케이스 앵커)으로 가리키고,
 *   공개 조회와 같은 판정(loadServedRelease·published 노트·isPubliclyVisible 케이스·숨기지 않은 프로필)으로 확인합니다. 아니면 404.
 * - 저장은 대상 내용을 복사하지 않고 포인터만 남깁니다(공개 사례는 그때의 release, 노트·케이스는 그때의 version).
 * - 당사자(이의제기·안내): 공개 사례는 지금 active owner, 노트·케이스는 작성자, 프로필은 그 사용자.
 */
import { z } from 'zod'
import {
  HIDDEN_ITEM_KINDS,
  ITEM_KEY_MAX,
  type HiddenItemKind,
  type ReportTargetIdentity,
  type ReportTargetType,
  reportTargetKey,
} from '@peerchive/domain'
import {
  and,
  caseStudies,
  courses,
  eq,
  inArray,
  isNull,
  profiles,
  projectMembers,
  publications,
  seniorNotes,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { communitySpaceLabels, communitySpaceOwnerIds, resolveReportableSpace } from '../community/reporting'
import { type Actor, invalid, notFound } from '../errors'
import { HANDLE_PATTERN } from '../identity/profiles'
import { loadCurrentEditionModel } from '../portfolio/editions'
import { loadCaseStudiesWithRelease } from '../portfolio/release-scope'
import { isPubliclyVisible } from '../portfolio/view'
import { isUuid } from '../projects/access'
import { loadServedRelease } from '../publication/public-read'
import { issuesToFields } from '../validation'

/** 신고·조치가 가리키는 대상(DB 열과 같은 모양). */
export interface TargetPointer {
  targetType: ReportTargetType
  targetKey: string
  publicationId: string | null
  releaseId: string | null
  itemKind: HiddenItemKind | null
  itemKey: string | null
  seniorNoteId: string | null
  noteVersion: number | null
  caseStudyId: string | null
  caseStudyVersion: number | null
  profileUserId: string | null
  communitySpaceId: string | null
}

const empty = (targetType: ReportTargetType, identity: ReportTargetIdentity): TargetPointer => ({
  targetType,
  targetKey: reportTargetKey(identity),
  publicationId: null,
  releaseId: null,
  itemKind: null,
  itemKey: null,
  seniorNoteId: null,
  noteVersion: null,
  caseStudyId: null,
  caseStudyVersion: null,
  profileUserId: null,
  communitySpaceId: null,
})

const slug = z.string({ error: 'invalid' }).trim().toLowerCase().min(3, { error: 'invalid' }).max(60, { error: 'invalid' })
const handle = z.string({ error: 'invalid' }).trim().toLowerCase().min(3, { error: 'invalid' }).max(30, { error: 'invalid' })

const refSchemas = {
  publication: z.object({ slug }),
  publication_item: z.object({
    slug,
    kind: z.enum(HIDDEN_ITEM_KINDS, { error: 'invalid' }),
    key: z.string({ error: 'invalid' }).trim().min(1, { error: 'invalid' }).max(ITEM_KEY_MAX, { error: 'invalid' }),
  }),
  senior_note: z.object({ noteId: z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()) }),
  case_study: z.object({ handle, anchor: z.string({ error: 'invalid' }).regex(/^case-[1-5]$/, { error: 'invalid' }) }),
  profile: z.object({ handle }),
} as const

function parseRef<T extends keyof typeof refSchemas>(type: T, raw: unknown): z.output<(typeof refSchemas)[T]> {
  const result = refSchemas[type].safeParse(raw ?? {})
  if (!result.success) throw invalid(issuesToFields(result.error.issues, 'targetRef'))
  return result.data as z.output<(typeof refSchemas)[T]>
}

async function publicProfileUser(db: DbExecutor, rawHandle: string): Promise<{ userId: string; handle: string } | null> {
  if (!HANDLE_PATTERN.test(rawHandle)) return null
  const [row] = await db
    .select({ userId: profiles.userId, handle: profiles.handle })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(profiles.handle, rawHandle), eq(users.status, 'active'), isNull(profiles.hiddenAt)))
    .limit(1)
  return row ?? null
}

/**
 * 신고 대상이 지금 공개인지 확인하고 포인터를 돌려줍니다. 아니면 404(대상 종류·형식 오류는 422).
 * 커뮤니티 공간(C-02)은 공개가 아니므로 신고자(actor)가 그 공간을 읽거나 소개를 볼 수 있는지로 판정합니다(community/reporting.ts).
 */
export async function resolvePublicTarget(db: DbExecutor, type: ReportTargetType, rawRef: unknown, now: Date, actor?: Actor): Promise<TargetPointer> {
  switch (type) {
    case 'community_space': {
      if (!actor) throw notFound()
      const spaceId = await resolveReportableSpace(db, actor, rawRef)
      return { ...empty(type, { type, spaceId }), communitySpaceId: spaceId }
    }
    case 'publication': {
      const ref = parseRef('publication', rawRef)
      const served = await loadServedRelease(db, ref.slug, now)
      if (!served) throw notFound()
      const id = served.publication.id
      return { ...empty(type, { type, publicationId: id }), publicationId: id, releaseId: served.release.id }
    }
    case 'publication_item': {
      const ref = parseRef('publication_item', rawRef)
      const served = await loadServedRelease(db, ref.slug, now)
      if (!served) throw notFound()
      // 가린 항목은 사본에 없으므로 이미 공개가 아닙니다(404).
      const s = served.snapshot
      const exists =
        ref.kind === 'log'
          ? s.logs.some((l) => l.key === ref.key)
          : ref.kind === 'claim'
            ? s.claims.some((c) => c.key === ref.key)
            : s.artifacts.some((a) => a.artifactVersionId === ref.key)
      if (!exists) throw notFound()
      const id = served.publication.id
      return {
        ...empty(type, { type, publicationId: id, itemKind: ref.kind, itemKey: ref.key }),
        publicationId: id,
        releaseId: served.release.id,
        itemKind: ref.kind,
        itemKey: ref.key,
      }
    }
    case 'senior_note': {
      const ref = parseRef('senior_note', rawRef)
      const [note] = await db
        .select({ id: seniorNotes.id, version: seniorNotes.version })
        .from(seniorNotes)
        .where(and(eq(seniorNotes.id, ref.noteId), eq(seniorNotes.status, 'published')))
        .limit(1)
      if (!note) throw notFound()
      return { ...empty(type, { type, seniorNoteId: note.id }), seniorNoteId: note.id, noteVersion: note.version }
    }
    case 'case_study': {
      const ref = parseRef('case_study', rawRef)
      const owner = await publicProfileUser(db, ref.handle)
      if (!owner) throw notFound()
      const current = await loadCurrentEditionModel(db, owner.userId)
      const caseStudyId = current?.model.featured[Number(ref.anchor.slice('case-'.length)) - 1]
      if (!caseStudyId) throw notFound()
      const [row] = await loadCaseStudiesWithRelease(db, eq(caseStudies.id, caseStudyId), now)
      if (!row || row.caseStudy.userId !== owner.userId || !isPubliclyVisible(row)) throw notFound()
      return {
        ...empty(type, { type, caseStudyId: row.caseStudy.id }),
        caseStudyId: row.caseStudy.id,
        caseStudyVersion: row.caseStudy.version,
      }
    }
    case 'profile': {
      const ref = parseRef('profile', rawRef)
      const owner = await publicProfileUser(db, ref.handle)
      if (!owner) throw notFound()
      return { ...empty(type, { type, userId: owner.userId }), profileUserId: owner.userId }
    }
  }
}

/** 대상의 당사자(이의제기·조치 안내를 받는 사람). 공개 사례는 지금 active owner들. */
export async function affectedUserIds(
  db: DbExecutor,
  target: Pick<TargetPointer, 'targetType' | 'publicationId' | 'seniorNoteId' | 'caseStudyId' | 'profileUserId' | 'communitySpaceId'>,
): Promise<string[]> {
  switch (target.targetType) {
    case 'community_space':
      return target.communitySpaceId ? communitySpaceOwnerIds(db, target.communitySpaceId) : []
    case 'publication':
    case 'publication_item': {
      if (!target.publicationId) return []
      const rows = await db
        .select({ userId: projectMembers.userId })
        .from(publications)
        .innerJoin(projectMembers, eq(projectMembers.projectId, publications.projectId))
        .where(and(eq(publications.id, target.publicationId), eq(projectMembers.role, 'owner'), eq(projectMembers.status, 'active')))
      return rows.map((r) => r.userId)
    }
    case 'senior_note': {
      if (!target.seniorNoteId) return []
      const [row] = await db.select({ userId: seniorNotes.authorId }).from(seniorNotes).where(eq(seniorNotes.id, target.seniorNoteId)).limit(1)
      return row ? [row.userId] : []
    }
    case 'case_study': {
      if (!target.caseStudyId) return []
      const [row] = await db.select({ userId: caseStudies.userId }).from(caseStudies).where(eq(caseStudies.id, target.caseStudyId)).limit(1)
      return row ? [row.userId] : []
    }
    case 'profile':
      return target.profileUserId ? [target.profileUserId] : []
  }
}

const ITEM_LABELS: Readonly<Record<HiddenItemKind, string>> = { log: '기록', claim: '역할 선언', artifact: '파일' }

/** 대상 표시 글(운영자·당사자·신고자 화면). 공개 경로에 이미 보이는 값(slug·handle·과목 이름)만 씁니다. */
export async function targetLabels(db: DbExecutor, targets: readonly TargetPointer[]): Promise<Map<string, string>> {
  const pubIds = [...new Set(targets.map((t) => t.publicationId).filter((id): id is string => !!id))]
  const noteIds = [...new Set(targets.map((t) => t.seniorNoteId).filter((id): id is string => !!id))]
  const caseIds = [...new Set(targets.map((t) => t.caseStudyId).filter((id): id is string => !!id))]
  const spaceIds = [...new Set(targets.map((t) => t.communitySpaceId).filter((id): id is string => !!id))]
  const spaceBy = await communitySpaceLabels(db, spaceIds)
  const [pubRows, noteRows, caseRows] = await Promise.all([
    pubIds.length ? db.select({ id: publications.id, slug: publications.slug }).from(publications).where(inArray(publications.id, pubIds)) : [],
    noteIds.length
      ? db
          .select({ id: seniorNotes.id, title: courses.title })
          .from(seniorNotes)
          .innerJoin(courses, eq(courses.id, seniorNotes.courseId))
          .where(inArray(seniorNotes.id, noteIds))
      : [],
    caseIds.length ? db.select({ id: caseStudies.id, userId: caseStudies.userId }).from(caseStudies).where(inArray(caseStudies.id, caseIds)) : [],
  ])
  const userIds = [...new Set([...targets.map((t) => t.profileUserId), ...caseRows.map((c) => c.userId)].filter((id): id is string => !!id))]
  const handleRows = userIds.length ? await db.select({ userId: profiles.userId, handle: profiles.handle }).from(profiles).where(inArray(profiles.userId, userIds)) : []
  const slugBy = new Map(pubRows.map((r) => [r.id, r.slug]))
  const courseBy = new Map(noteRows.map((r) => [r.id, r.title]))
  const caseUser = new Map(caseRows.map((r) => [r.id, r.userId]))
  const handleBy = new Map(handleRows.map((r) => [r.userId, r.handle]))
  const out = new Map<string, string>()
  for (const t of targets) {
    let label: string
    switch (t.targetType) {
      case 'publication':
        label = `공개 사례 /p/${slugBy.get(t.publicationId ?? '') ?? '?'}`
        break
      case 'publication_item':
        label = `공개 사례 /p/${slugBy.get(t.publicationId ?? '') ?? '?'} · ${t.itemKind ? ITEM_LABELS[t.itemKind] : '항목'}`
        break
      case 'senior_note':
        label = `선배 노트 · ${courseBy.get(t.seniorNoteId ?? '') ?? '과목'}`
        break
      case 'case_study': {
        const h = handleBy.get(caseUser.get(t.caseStudyId ?? '') ?? '')
        label = `케이스 스터디 · ${h ? `@${h}` : '사용자'}`
        break
      }
      case 'profile': {
        const h = handleBy.get(t.profileUserId ?? '')
        label = `공개 프로필 ${h ? `@${h}` : ''}`.trim()
        break
      }
      case 'community_space':
        label = `커뮤니티 공간 · ${spaceBy.get(t.communitySpaceId ?? '')?.name ?? '공간'}`
        break
    }
    out.set(t.targetKey, label)
  }
  return out
}

/** 행(신고·조치)에서 포인터 열만. 조치 행에는 version 열이 없습니다. */
export function pointerOf(
  row: Omit<TargetPointer, 'noteVersion' | 'caseStudyVersion' | 'communitySpaceId'> & {
    noteVersion?: number | null
    caseStudyVersion?: number | null
    communitySpaceId?: string | null
  },
): TargetPointer {
  return {
    targetType: row.targetType,
    targetKey: row.targetKey,
    publicationId: row.publicationId,
    releaseId: row.releaseId,
    itemKind: row.itemKind,
    itemKey: row.itemKey,
    seniorNoteId: row.seniorNoteId,
    noteVersion: row.noteVersion ?? null,
    caseStudyId: row.caseStudyId,
    caseStudyVersion: row.caseStudyVersion ?? null,
    profileUserId: row.profileUserId,
    communitySpaceId: row.communitySpaceId ?? null,
  }
}

export { isUuid }
