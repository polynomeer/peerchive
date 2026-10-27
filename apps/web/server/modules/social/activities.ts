/**
 * 페르소나 활동 투영 (S-02, SYSTEM_DESIGN §6.7.1 PersonaActivity·§8.3 불변조건 1·§11.3 피드, DELIVERY_PLAN §4.2 S-02·§5.2 Q, ADR 0029).
 *
 * 공개 프로필의 활동 목록과 팔로우 피드(S-05)가 읽는 유일한 원천(persona_activities)에 쓰는 **단 하나의 길**입니다.
 * - 이 모듈(social)은 커뮤니티 글 테이블·커뮤니티 모듈을 import하지 않습니다(경계 테스트 identity-boundary.test.ts). 원천의 사실은 원본 모듈이
 *   자기 테이블에서 읽어 `PersonaActivitySourceFacts`로 넘기고(커뮤니티 글이면 커뮤니티 모듈), 여기서는 `decidePersonaActivityProjection`으로
 *   거른 뒤에만 넣습니다.
 * - 넘겨받은 사실이 틀려도 DB 트리거(persona_activities_projection_guard)가 원본 행으로 다시 확인해 0~1단계 글·익명 노트·익명 스터디 release·
 *   다른 사람의 페르소나·종류가 다른 페르소나를 거부합니다(23514). 애플리케이션의 규칙과 DB의 규칙이 둘 다 통과해야 행이 생깁니다.
 * - 원본이 숨김·삭제·철회·방식 재선택되면 `withdrawPersonaActivities`로 withdrawn_at을 채웁니다(행은 남김). 읽기(S-05)는 withdrawn_at이 없는
 *   행만 보고, 항목마다 원본 상태를 다시 확인합니다(§11.3).
 *
 * 지금(S-02)은 원본 모듈이 이 함수를 아직 부르지 않습니다: 활동 목록·피드 화면(S-05)과 철회 연결을 함께 붙입니다(ADR 0029).
 */
import { and, desc, eq, isNull, personaActivities, personas, type DbExecutor } from '@peerchive/db'
import {
  type PersonaActivityItemKind,
  type PersonaActivitySource,
  type PersonaActivitySourceFacts,
  type ProjectionRefusal,
  decidePersonaActivityProjection,
} from '@peerchive/domain'

export interface ProjectPersonaActivityInput {
  personaId: string
  sourceId: string
  source: PersonaActivitySourceFacts
  /** 원천의 시각(글 작성·release 게시 시각). */
  occurredAt: Date
}

export type ProjectPersonaActivityResult = { projected: true; activityId: string | null } | { projected: false; reason: ProjectionRefusal | 'unknown_persona' }

/**
 * 원천 하나를 페르소나 활동으로 투영합니다. 규칙이 거부하면 아무것도 쓰지 않고 이유를 돌려줍니다. 같은 (페르소나, 원천)은 한 번만(이미 있으면 activityId null).
 * 원본 모듈의 트랜잭션 안에서(같은 트랜잭션의 outbox 처리로) 부릅니다.
 */
export async function projectPersonaActivity(db: DbExecutor, input: ProjectPersonaActivityInput): Promise<ProjectPersonaActivityResult> {
  const [persona] = await db.select({ id: personas.id, kind: personas.kind }).from(personas).where(eq(personas.id, input.personaId)).limit(1)
  if (!persona) return { projected: false, reason: 'unknown_persona' }
  const decision = decidePersonaActivityProjection(input.source, persona)
  if (!decision.project) return { projected: false, reason: decision.reason }
  const [row] = await db
    .insert(personaActivities)
    .values({ personaId: persona.id, sourceType: input.source.type, sourceId: input.sourceId, itemKind: decision.itemKind, createdAt: input.occurredAt })
    .onConflictDoNothing()
    .returning({ id: personaActivities.id })
  return { projected: true, activityId: row?.id ?? null }
}

/** 원천의 모든 투영을 거둡니다(숨김·삭제·철회·방식 재선택). 이미 거둔 행은 그대로. 거둔 행 수. */
export async function withdrawPersonaActivities(db: DbExecutor, sourceType: PersonaActivitySource, sourceId: string, now: Date): Promise<number> {
  const rows = await db
    .update(personaActivities)
    .set({ withdrawnAt: now })
    .where(and(eq(personaActivities.sourceType, sourceType), eq(personaActivities.sourceId, sourceId), isNull(personaActivities.withdrawnAt)))
    .returning({ id: personaActivities.id })
  return rows.length
}

export interface PersonaActivityRow {
  sourceType: PersonaActivitySource
  sourceId: string
  itemKind: PersonaActivityItemKind
  createdAt: Date
}

/**
 * 한 페르소나의 거두지 않은 활동(최근 순). persona_activities만 읽습니다. 공개 응답으로 내보내기 전의 원본 상태 재확인·공개 범위(canViewPersonaItem)는
 * 활동 목록 API(S-05)가 합니다.
 */
export async function listPersonaActivities(db: DbExecutor, personaId: string, limit = 50): Promise<PersonaActivityRow[]> {
  const rows = await db
    .select({ sourceType: personaActivities.sourceType, sourceId: personaActivities.sourceId, itemKind: personaActivities.itemKind, createdAt: personaActivities.createdAt })
    .from(personaActivities)
    .where(and(eq(personaActivities.personaId, personaId), isNull(personaActivities.withdrawnAt)))
    .orderBy(desc(personaActivities.createdAt), desc(personaActivities.id))
    .limit(Math.min(Math.max(limit, 1), 200))
  return rows.map((r) => ({ ...r, itemKind: r.itemKind as PersonaActivityItemKind }))
}
