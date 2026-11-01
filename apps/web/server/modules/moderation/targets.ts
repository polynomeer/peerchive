/**
 * 신고 대상 판정 (T-15, ADR 0015).
 *
 * - 신고 대상은 **지금 공개인 것**뿐입니다. 공개 화면이 보여 주는 값(slug·스냅샷 키·노트 id·handle·대표 케이스 앵커)으로 가리키고,
 *   공개 조회와 같은 판정(loadServedRelease·published 노트·isPubliclyVisible 케이스·숨기지 않은 프로필)으로 확인합니다. 아니면 404.
 * - 저장은 대상 내용을 복사하지 않고 포인터만 남깁니다(공개 사례는 그때의 release, 노트·케이스는 그때의 version).
 * - 당사자(이의제기·안내): 공개 사례는 지금 active owner, 노트·케이스는 작성자, 프로필은 그 사용자.
 * - S-07(ADR 0036): 페르소나(`{handle}`, 실명·표시명 어느 쪽이든)·프로필 글(`{activityId}`)·소셜 링크(`{handle, url}`). 판정은 social 모듈의 공개 경로와
 *   같고(공개 상태 + 신고자에게 차단으로 숨겨지지 않음 + 글은 `posts` 공개 범위), 포인터는 **그 페르소나·글·링크 하나**뿐입니다 — 주인 사용자로 풀지
 *   않으므로 표시명 신고가 실명 프로필·실명 handle과 이어지지 않습니다. 이름표는 그 페르소나 자신의 handle입니다.
 * - A-06(ADR 0043): 수료 회고(`{retroId}`). 공개 대상이 아니라 신고자가 읽을 수 있는(active 기관 인증) 게시 중인 회고만, institutions 플래그가
 *   꺼지면 404. 당사자는 작성자, 이름표는 "수료 회고 · 고정된 기관 표시"(넓혀졌으면 넓힌 문자열 — 기관 이름을 새로 드러내지 않음).
 * - A-07(ADR 0045): 동문회·OB 방 항목(`{spaceSlug, kind, itemId}`). 그 방 active 멤버가 지금 보는 숨기지 않은 항목만(alumni 플래그 꺼짐 404).
 *   포인터는 종류 + 항목 id, 당사자는 그 항목의 주인(명부·방별 프로필의 사람, 일정·투표를 만든 사람, 사진을 올린 사람), 이름표는 "종류 · 방 이름".
 */
import { z } from 'zod'
import {
  HIDDEN_ITEM_KINDS,
  ITEM_KEY_MAX,
  type HiddenItemKind,
  type ReportTargetIdentity,
  type RoomItemKind,
  type ReportTargetType,
  reportTargetKey,
} from '@peerchive/domain'
import {
  and,
  caseStudies,
  completionRetros,
  courseQaItems,
  courses,
  eq,
  inArray,
  isNull,
  personas,
  profilePosts,
  profiles,
  projectMembers,
  publications,
  seniorNotes,
  socialLinks,
  users,
  type DbExecutor,
} from '@peerchive/db'
import {
  applyReportThresholdInTx,
  communityItemAuthorIds,
  communityItemLabels,
  communitySpaceLabels,
  communitySpaceOwnerIds,
  recruitmentItemLabels,
  recruitmentItemPartyIds,
  resolveReportableApplication,
  resolveReportableComment,
  resolveReportablePost,
  resolveReportableRecruitment,
  resolveReportableSpace,
  resolveReportableRoomItem,
  roomItemKindOf,
  roomItemLabels,
  roomItemOwnerIds,
} from '../community/reporting'
import { type Actor, invalid, notFound } from '../errors'
import { HANDLE_PATTERN } from '../identity/profiles'
import { loadCurrentEditionModel } from '../portfolio/editions'
import { loadCaseStudiesWithRelease } from '../portfolio/release-scope'
import { isPubliclyVisible } from '../portfolio/view'
import { isUuid } from '../projects/access'
import { loadServedRelease } from '../publication/public-read'
import { resolveReportableRetro } from '../institutions/completion-retros'
import { resolvePublicPersona } from '../social/personas'
import { reportableProfilePost } from '../social/profile-posts'
import { isHiddenFrom } from '../social/relations'
import { reportableSocialLink } from '../social/social-links'
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
  communityPostId: string | null
  communityCommentId: string | null
  communityRecruitmentId: string | null
  communityApplicationId: string | null
  /** 막힘 Q&A(C-09). */
  courseQaItemId: string | null
  /** S-07: 페르소나·프로필 글·소셜 링크(대상 하나만, 주인 사용자 없음). */
  personaId: string | null
  profilePostId: string | null
  socialLinkId: string | null
  /** A-06: 수료 회고. */
  completionRetroId: string | null
  /** A-07: 방 항목(종류 + 항목 id, 주인 사용자 없음). */
  roomItemKind: RoomItemKind | null
  roomItemId: string | null
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
  communityPostId: null,
  communityCommentId: null,
  communityRecruitmentId: null,
  communityApplicationId: null,
  courseQaItemId: null,
  personaId: null,
  profilePostId: null,
  socialLinkId: null,
  completionRetroId: null,
  roomItemKind: null,
  roomItemId: null,
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
  persona: z.object({ handle }),
  profile_post: z.object({ activityId: z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()) }),
  social_link: z.object({ handle, url: z.string({ error: 'invalid' }).trim().min(1, { error: 'invalid' }).max(300, { error: 'invalid' }) }),
  course_qa: z.object({ qaId: z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()) }),
  completion_retro: z.object({ retroId: z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()) }),
} as const

function parseRef<T extends keyof typeof refSchemas>(type: T, raw: unknown): z.output<(typeof refSchemas)[T]> {
  const result = refSchemas[type].safeParse(raw ?? {})
  if (!result.success) throw invalid(issuesToFields(result.error.issues, 'targetRef'))
  return result.data as z.output<(typeof refSchemas)[T]>
}

/**
 * 신고할 수 있는 공개 프로필(실명 페르소나만, S-01). 표시명 프로필은 user_id가 없어 여기서 집히지 않습니다 — 표시명 페르소나 신고는
 * 신고·조치가 사용자 단위(profile_user_id)라 실명 프로필과 연결되므로 S-07에서 페르소나 단위로 엽니다(ADR 0028).
 */
async function publicProfileUser(db: DbExecutor, rawHandle: string): Promise<{ userId: string; personaId: string; handle: string } | null> {
  if (!HANDLE_PATTERN.test(rawHandle)) return null
  const [row] = await db
    .select({ userId: users.id, personaId: profiles.personaId, handle: profiles.handle })
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
    // 커뮤니티 글·댓글(C-04): 신고자가 읽을 수 있는 게시 중인 것만. 공간 id는 넣지 않습니다(공간 조치가 아니므로 방장이 당사자가 되지 않게).
    case 'community_post': {
      if (!actor) throw notFound()
      const postId = await resolveReportablePost(db, actor, rawRef)
      return { ...empty(type, { type, postId }), communityPostId: postId }
    }
    case 'community_comment': {
      if (!actor) throw notFound()
      const commentId = await resolveReportableComment(db, actor, rawRef)
      return { ...empty(type, { type, commentId }), communityCommentId: commentId }
    }
    // 모집 글(C-07): 신고자가 볼 수 있는 가려지지 않은 모집. 지원 메시지: 그 모집의 모집자만(메시지를 보는 사람이 모집자뿐).
    case 'community_recruitment': {
      if (!actor) throw notFound()
      const recruitmentId = await resolveReportableRecruitment(db, actor, rawRef, now)
      return { ...empty(type, { type, recruitmentId }), communityRecruitmentId: recruitmentId }
    }
    case 'community_application': {
      if (!actor) throw notFound()
      const applicationId = await resolveReportableApplication(db, actor, rawRef, now)
      return { ...empty(type, { type, applicationId }), communityApplicationId: applicationId }
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
    // 막힘 Q&A(C-09): 지금 게시 중인 것만(공개 대상, 로그인한 누구나).
    case 'course_qa': {
      const ref = parseRef('course_qa', rawRef)
      const [qa] = await db
        .select({ id: courseQaItems.id })
        .from(courseQaItems)
        .where(and(eq(courseQaItems.id, ref.qaId), eq(courseQaItems.status, 'published')))
        .limit(1)
      if (!qa) throw notFound()
      return { ...empty(type, { type, courseQaId: qa.id }), courseQaItemId: qa.id }
    }
    case 'case_study': {
      const ref = parseRef('case_study', rawRef)
      const owner = await publicProfileUser(db, ref.handle)
      if (!owner) throw notFound()
      const current = await loadCurrentEditionModel(db, owner.personaId)
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
    // S-07: 공개 프로필과 같은 판정(resolvePublicPersona) + 신고자에게 차단으로 숨겨지지 않음. 포인터는 페르소나 id 하나.
    case 'persona': {
      const ref = parseRef('persona', rawRef)
      const persona = await reportablePersona(db, ref.handle, actor)
      return { ...empty(type, { type, personaId: persona.id }), personaId: persona.id }
    }
    case 'profile_post': {
      if (!actor) throw notFound()
      const ref = parseRef('profile_post', rawRef)
      const { profilePostId } = await reportableProfilePost(db, actor, ref.activityId)
      return { ...empty(type, { type, profilePostId }), profilePostId }
    }
    case 'social_link': {
      const ref = parseRef('social_link', rawRef)
      const persona = await reportablePersona(db, ref.handle, actor)
      const { socialLinkId } = await reportableSocialLink(db, persona.id, ref.url)
      return { ...empty(type, { type, socialLinkId }), socialLinkId }
    }
    // A-06: 신고자가 읽을 수 있는 게시 중인 수료 회고(플래그 꺼짐·읽을 수 없음 404).
    case 'completion_retro': {
      if (!actor) throw notFound()
      const ref = parseRef('completion_retro', rawRef)
      const retroId = await resolveReportableRetro(db, actor, ref.retroId)
      return { ...empty(type, { type, retroId }), completionRetroId: retroId }
    }
    // A-07: 신고자가 그 방 active 멤버로 지금 보는 숨기지 않은 방 항목.
    case 'room_item': {
      if (!actor) throw notFound()
      const { kind, itemId } = await resolveReportableRoomItem(db, actor, rawRef, now)
      return { ...empty(type, { type, kind, itemId }), roomItemKind: kind, roomItemId: itemId }
    }
  }
}

/** 신고할 수 있는 페르소나(공개 상태, 신고자에게 숨겨지지 않음). 아니면 404. */
async function reportablePersona(db: DbExecutor, rawHandle: string, actor: Actor | undefined): Promise<{ id: string; userId: string }> {
  const { persona } = await resolvePublicPersona(db, rawHandle)
  if (actor && (await isHiddenFrom(db, persona, actor.userId))) throw notFound()
  return persona
}

/**
 * 신고를 저장한 같은 트랜잭션에서 부릅니다(C-06): 커뮤니티 글·댓글이면 서로 다른 인증 신고자 수를 세어 기준에 이르면 임시 숨김(community/reporting.ts).
 * 임시 숨김으로 바꿨으면 true. 다른 대상은 아무것도 하지 않습니다.
 */
export async function afterReportCreated(tx: DbExecutor, target: TargetPointer, reporterId: string, now: Date): Promise<boolean> {
  if (target.targetType === 'community_post' || target.targetType === 'community_comment') {
    return applyReportThresholdInTx(tx, { postId: target.communityPostId, commentId: target.communityCommentId }, reporterId, now)
  }
  return false
}

/** 대상의 당사자(이의제기·조치 안내를 받는 사람). 공개 사례는 지금 active owner들. */
export async function affectedUserIds(
  db: DbExecutor,
  target: Pick<
    TargetPointer,
    | 'targetType'
    | 'publicationId'
    | 'seniorNoteId'
    | 'caseStudyId'
    | 'profileUserId'
    | 'communitySpaceId'
    | 'communityPostId'
    | 'communityCommentId'
    | 'communityRecruitmentId'
    | 'communityApplicationId'
    | 'courseQaItemId'
    | 'personaId'
    | 'profilePostId'
    | 'socialLinkId'
    | 'completionRetroId'
    | 'roomItemKind'
    | 'roomItemId'
  >,
): Promise<string[]> {
  switch (target.targetType) {
    case 'community_space':
      return target.communitySpaceId ? communitySpaceOwnerIds(db, target.communitySpaceId) : []
    case 'community_post':
    case 'community_comment':
      return communityItemAuthorIds(db, { postId: target.communityPostId, commentId: target.communityCommentId })
    case 'community_recruitment':
    case 'community_application':
      return recruitmentItemPartyIds(db, { recruitmentId: target.communityRecruitmentId, applicationId: target.communityApplicationId })
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
    // 막힘 Q&A(C-09): 질문한 사람·답한 사람(탈퇴 정리 뒤에는 빔).
    case 'course_qa': {
      if (!target.courseQaItemId) return []
      const [row] = await db
        .select({ askerId: courseQaItems.askerId, answererId: courseQaItems.answererId })
        .from(courseQaItems)
        .where(eq(courseQaItems.id, target.courseQaItemId))
        .limit(1)
      return row ? [...new Set([row.askerId, row.answererId].filter((id): id is string => !!id))] : []
    }
    // S-07: 그 페르소나·글·링크의 주인(탈퇴 정리로 지워졌으면 없음).
    case 'persona': {
      if (!target.personaId) return []
      const [row] = await db.select({ userId: personas.userId }).from(personas).where(eq(personas.id, target.personaId)).limit(1)
      return row ? [row.userId] : []
    }
    case 'profile_post': {
      if (!target.profilePostId) return []
      const [row] = await db.select({ userId: profilePosts.userId }).from(profilePosts).where(eq(profilePosts.id, target.profilePostId)).limit(1)
      return row ? [row.userId] : []
    }
    case 'social_link': {
      if (!target.socialLinkId) return []
      const [row] = await db.select({ userId: socialLinks.userId }).from(socialLinks).where(eq(socialLinks.id, target.socialLinkId)).limit(1)
      return row ? [row.userId] : []
    }
    case 'completion_retro': {
      if (!target.completionRetroId) return []
      const [row] = await db.select({ userId: completionRetros.authorId }).from(completionRetros).where(eq(completionRetros.id, target.completionRetroId)).limit(1)
      return row ? [row.userId] : []
    }
    case 'room_item':
      return roomItemOwnerIds(db, target.roomItemKind, target.roomItemId)
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
  const itemSpaceBy = await communityItemLabels(
    db,
    [...new Set(targets.map((t) => t.communityPostId).filter((id): id is string => !!id))],
    [...new Set(targets.map((t) => t.communityCommentId).filter((id): id is string => !!id))],
  )
  const recruitmentBy = await recruitmentItemLabels(
    db,
    [...new Set(targets.map((t) => t.communityRecruitmentId).filter((id): id is string => !!id))],
    [...new Set(targets.map((t) => t.communityApplicationId).filter((id): id is string => !!id))],
  )
  const qaIds = [...new Set(targets.map((t) => t.courseQaItemId).filter((id): id is string => !!id))]
  const qaRows = qaIds.length
    ? await db.select({ id: courseQaItems.id, title: courses.title }).from(courseQaItems).innerJoin(courses, eq(courses.id, courseQaItems.courseId)).where(inArray(courseQaItems.id, qaIds))
    : []
  const qaCourseBy = new Map(qaRows.map((r) => [r.id, r.title]))
  const retroIds = [...new Set(targets.map((t) => t.completionRetroId).filter((id): id is string => !!id))]
  const retroRows = retroIds.length
    ? await db.select({ id: completionRetros.id, label: completionRetros.institutionLabel }).from(completionRetros).where(inArray(completionRetros.id, retroIds))
    : []
  const retroLabelBy = new Map(retroRows.map((r) => [r.id, r.label]))
  const roomItemBy = await roomItemLabels(
    db,
    targets.filter((t) => t.roomItemKind && t.roomItemId).map((t) => ({ kind: t.roomItemKind!, id: t.roomItemId! })),
  )
  const personaHandleBy = await personaHandles(db, targets)
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
      case 'community_post':
        label = `커뮤니티 글 · ${itemSpaceBy.get(t.communityPostId ?? '') ?? '공간'}`
        break
      case 'community_comment':
        label = `커뮤니티 댓글 · ${itemSpaceBy.get(t.communityCommentId ?? '') ?? '공간'}`
        break
      case 'community_recruitment':
        label = `모집 글 · ${recruitmentBy.get(t.communityRecruitmentId ?? '') ?? '모집'}`
        break
      case 'community_application':
        label = `지원 메시지 · ${recruitmentBy.get(t.communityApplicationId ?? '') ?? '모집'}`
        break
      case 'course_qa':
        label = `막힘 Q&A · ${qaCourseBy.get(t.courseQaItemId ?? '') ?? '과목'}`
        break
      case 'persona': {
        const p = personaHandleBy.persona.get(t.personaId ?? '')
        label = p ? `공개 프로필 @${p.handle}${p.kind === 'display' ? ' (표시명)' : ''}` : '공개 프로필'
        break
      }
      case 'profile_post': {
        const p = personaHandleBy.post.get(t.profilePostId ?? '')
        label = `프로필 글${p ? ` · @${p.handle}` : ''}`
        break
      }
      case 'social_link': {
        const p = personaHandleBy.link.get(t.socialLinkId ?? '')
        label = `소셜 링크${p ? ` · @${p.handle}` : ''}`
        break
      }
      case 'completion_retro': {
        const l = retroLabelBy.get(t.completionRetroId ?? '')
        label = `수료 회고${l ? ` · ${l}` : ''}`
        break
      }
      case 'room_item':
        label = roomItemBy.get(`${t.roomItemKind}:${t.roomItemId}`)?.label ?? '방 항목'
        break
    }
    out.set(t.targetKey, label)
  }
  return out
}

type PersonaLabel = { handle: string; kind: 'real' | 'display' }

/** S-07 이름표: 대상 페르소나(글·링크는 그 글·링크의 페르소나) **자신의** handle·종류. 같은 사람의 다른 페르소나는 읽지 않습니다. */
async function personaHandles(
  db: DbExecutor,
  targets: readonly TargetPointer[],
): Promise<{ persona: Map<string, PersonaLabel>; post: Map<string, PersonaLabel>; link: Map<string, PersonaLabel> }> {
  const ids = (pick: (t: TargetPointer) => string | null) => [...new Set(targets.map(pick).filter((id): id is string => !!id))]
  const personaIds = ids((t) => t.personaId)
  const postIds = ids((t) => t.profilePostId)
  const linkIds = ids((t) => t.socialLinkId)
  const cols = { handle: personas.handle, kind: personas.kind }
  const [pRows, postRows, linkRows] = await Promise.all([
    personaIds.length ? db.select({ id: personas.id, ...cols }).from(personas).where(inArray(personas.id, personaIds)) : [],
    postIds.length
      ? db.select({ id: profilePosts.id, ...cols }).from(profilePosts).innerJoin(personas, eq(personas.id, profilePosts.personaId)).where(inArray(profilePosts.id, postIds))
      : [],
    linkIds.length
      ? db.select({ id: socialLinks.id, ...cols }).from(socialLinks).innerJoin(personas, eq(personas.id, socialLinks.personaId)).where(inArray(socialLinks.id, linkIds))
      : [],
  ])
  const toMap = (rows: Array<{ id: string } & PersonaLabel>) => new Map(rows.map((r) => [r.id, { handle: r.handle, kind: r.kind }]))
  return { persona: toMap(pRows), post: toMap(postRows), link: toMap(linkRows) }
}

/** 행(신고·조치)에서 포인터 열만. 조치 행에는 version 열이 없습니다. */
export function pointerOf(
  row: Omit<
    TargetPointer,
    | 'noteVersion'
    | 'caseStudyVersion'
    | 'communitySpaceId'
    | 'communityPostId'
    | 'communityCommentId'
    | 'communityRecruitmentId'
    | 'communityApplicationId'
    | 'courseQaItemId'
    | 'personaId'
    | 'profilePostId'
    | 'socialLinkId'
    | 'completionRetroId'
    | 'roomItemKind'
    | 'roomItemId'
  > & {
    noteVersion?: number | null
    caseStudyVersion?: number | null
    communitySpaceId?: string | null
    communityPostId?: string | null
    communityCommentId?: string | null
    communityRecruitmentId?: string | null
    communityApplicationId?: string | null
    courseQaItemId?: string | null
    personaId?: string | null
    profilePostId?: string | null
    socialLinkId?: string | null
    completionRetroId?: string | null
    roomItemKind?: RoomItemKind | null
    roomItemId?: string | null
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
    communityPostId: row.communityPostId ?? null,
    communityCommentId: row.communityCommentId ?? null,
    communityRecruitmentId: row.communityRecruitmentId ?? null,
    communityApplicationId: row.communityApplicationId ?? null,
    courseQaItemId: row.courseQaItemId ?? null,
    personaId: row.personaId ?? null,
    profilePostId: row.profilePostId ?? null,
    socialLinkId: row.socialLinkId ?? null,
    completionRetroId: row.completionRetroId ?? null,
    roomItemKind: row.roomItemKind ?? null,
    roomItemId: row.roomItemId ?? null,
  }
}

export { isUuid }

// A-07: notices.ts·reports.ts는 커뮤니티 모듈을 직접 import하지 않고 여기서 받습니다(C-05 경계의 어댑터는 operator·targets·actions뿐).
export { roomItemKindOf, roomItemLabels }
