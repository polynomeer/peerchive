/**
 * 페르소나 활동 투영 처리기(S-05, SYSTEM_DESIGN §6.7.1 PersonaActivity "원본 모듈이 outbox로 투영"·§11.3, ADR 0029·0035).
 *
 * - 원본 모듈(커뮤니티 글 작성·선배 노트 게시·release 게시)이 같은 트랜잭션에 남긴 `persona_activity.project`를 받아 persona_activities에 넣습니다.
 *   - 선배 노트·release: **지금 원본 행을 다시 읽고** @peerchive/domain `decidePersonaActivityProjection`을 통과한 페르소나만(노트 작성자의 같은 종류
 *     페르소나, release의 granted 동의 당사자마다 실명 페르소나).
 *   - 커뮤니티 글: 커뮤니티 모듈이 자기 행으로 같은 규칙을 판정해 넘긴 작성 시점 페르소나·시각만 씁니다. **worker는 커뮤니티 테이블을 읽지 않습니다**
 *     (C-05 경계: worker 파생 처리기는 커뮤니티 코드·테이블에 닿지 않음).
 * - 어느 쪽이든 INSERT는 `persona_activity_source_ok`(원본 행으로 같은 규칙)를 통과할 때만 하고, DB 트리거가 한 번 더 확인합니다. 그 사이 원본이
 *   지워지거나 숨겨졌으면 아무것도 넣지 않습니다(재시도로 실패를 되풀이하지 않음). 이미 있고 거둔 행은 같은 확인을 통과할 때만 되살립니다.
 * - 이벤트가 늦거나 중복·순서가 바뀌어도 결과가 같습니다(idempotent). 거두기 자체는 원본 상태가 바뀌는 트랜잭션의 DB 트리거가 합니다.
 * - 웹의 social 모듈(`social/activities.ts`)과 같은 일을 합니다(worker는 웹 모듈을 import할 수 없음). 로그에는 id·개수만 남깁니다.
 */
import type { PgBoss } from 'pg-boss'
import {
  PERSONA_ACTIVITY_PROJECT_TOPIC,
  and,
  consents,
  eq,
  personas,
  publicationCandidates,
  seniorNotes,
  sql,
  type DbExecutor,
  type PersonaActivityProjectOutboxPayload,
} from '@peerchive/db'
import { type PersonaActivityItemKind, type PersonaActivitySourceFacts, decidePersonaActivityProjection, personaActivityItemKind } from '@peerchive/domain'
import { PUBLICATION_QUEUE_OPTIONS } from './publication-events'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPES = ['publication_release', 'senior_note', 'study_release', 'community_post'] as const

export function parsePersonaActivityPayload(data: unknown): PersonaActivityProjectOutboxPayload | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.sourceId !== 'string' || !UUID.test(d.sourceId)) return null
  if (!(TYPES as readonly unknown[]).includes(d.sourceType)) return null
  const base = { sourceType: d.sourceType as PersonaActivityProjectOutboxPayload['sourceType'], sourceId: d.sourceId.toLowerCase() }
  if (base.sourceType !== 'community_post') return base
  // 커뮤니티 글은 커뮤니티 모듈이 판정한 페르소나와 작성 시각이 있어야 합니다.
  if (typeof d.personaId !== 'string' || !UUID.test(d.personaId)) return null
  if (typeof d.occurredAt !== 'string' || Number.isNaN(Date.parse(d.occurredAt))) return null
  return { ...base, personaId: d.personaId.toLowerCase(), occurredAt: new Date(d.occurredAt).toISOString() }
}

/** 원천 확인(`persona_activity_source_ok`)을 통과할 때만 넣거나(처음) 되살립니다(거둔 행). 넣거나 되살린 행 수(0·1). */
async function insertGuarded(
  tx: DbExecutor,
  personaId: string,
  sourceType: PersonaActivitySourceFacts['type'],
  sourceId: string,
  itemKind: PersonaActivityItemKind,
  occurredAt: Date,
): Promise<number> {
  const ok = sql`persona_activity_source_ok(${personaId}::uuid, ${sourceType}::persona_activity_source, ${sourceId}::uuid)`
  const inserted = (await tx.execute(sql`
    insert into persona_activities (persona_id, source_type, source_id, item_kind, created_at)
    select ${personaId}::uuid, ${sourceType}::persona_activity_source, ${sourceId}::uuid, ${itemKind}, ${occurredAt.toISOString()}::timestamptz
    where ${ok}
    on conflict do nothing
    returning id`)) as unknown as Array<{ id: string }>
  if (inserted.length) return 1
  const restored = (await tx.execute(sql`
    update persona_activities set withdrawn_at = null
    where persona_id = ${personaId}::uuid and source_type = ${sourceType}::persona_activity_source and source_id = ${sourceId}::uuid
      and withdrawn_at is not null and ${ok}
    returning id`)) as unknown as Array<{ id: string }>
  return restored.length
}

/** 지금 원본 행의 사실로 규칙을 통과한 페르소나에만. */
async function projectWithFacts(tx: DbExecutor, personaId: string, sourceId: string, source: PersonaActivitySourceFacts, occurredAt: Date): Promise<number> {
  const [persona] = await tx.select({ id: personas.id, kind: personas.kind }).from(personas).where(eq(personas.id, personaId)).limit(1)
  if (!persona) return 0
  const decision = decidePersonaActivityProjection(source, persona)
  if (!decision.project) return 0
  return insertGuarded(tx, personaId, source.type, sourceId, decision.itemKind, occurredAt)
}

/** 이벤트 하나 처리(테스트에서도 직접 부름). 넣거나 되살린 활동 수. 형식이 틀리면 0. */
export async function handlePersonaActivityProject(db: DbExecutor, data: unknown): Promise<number> {
  const event = parsePersonaActivityPayload(data)
  if (!event) {
    console.error('[worker] persona_activity.project: invalid payload')
    return 0
  }
  return db.transaction(async (tx) => {
    switch (event.sourceType) {
      case 'community_post': {
        // 익명 글은 이벤트가 없지만, 있더라도 원천 확인(작성 시점 페르소나·방식·listed·게시 중)이 거부합니다.
        const [persona] = await tx.select({ id: personas.id }).from(personas).where(eq(personas.id, event.personaId!)).limit(1)
        if (!persona) return 0
        return insertGuarded(tx, persona.id, 'community_post', event.sourceId, personaActivityItemKind('community_post'), new Date(event.occurredAt!))
      }
      case 'senior_note': {
        const [note] = await tx
          .select({ authorId: seniorNotes.authorId, displayMode: seniorNotes.displayMode, status: seniorNotes.status, publishedAt: seniorNotes.publishedAt })
          .from(seniorNotes)
          .where(eq(seniorNotes.id, event.sourceId))
          .limit(1)
          .for('share')
        // 익명·소속 표시(A-06) 노트는 투영하지 않습니다(이벤트도 없지만 있더라도).
        if (!note || (note.displayMode !== 'name' && note.displayMode !== 'display')) return 0
        const kind = note.displayMode === 'name' ? 'real' : 'display'
        const [persona] = await tx
          .select({ id: personas.id })
          .from(personas)
          .where(and(eq(personas.userId, note.authorId), eq(personas.kind, kind)))
          .limit(1)
        if (!persona) return 0
        return projectWithFacts(
          tx,
          persona.id,
          event.sourceId,
          { type: 'senior_note', displayMode: note.displayMode, published: note.status === 'published' },
          note.publishedAt ?? new Date(),
        )
      }
      case 'publication_release':
      case 'study_release': {
        const [release] = await tx
          .select({ status: publicationCandidates.status, snapshot: publicationCandidates.snapshot, publishedAt: publicationCandidates.publishedAt })
          .from(publicationCandidates)
          .where(eq(publicationCandidates.id, event.sourceId))
          .limit(1)
          .for('share')
        if (!release) return 0
        // 동의한 당사자마다 실명 페르소나(없으면 건너뜀).
        const subjects = await tx
          .select({ personaId: personas.id })
          .from(consents)
          .innerJoin(personas, and(eq(personas.userId, consents.subjectUserId), eq(personas.kind, 'real')))
          .where(and(eq(consents.candidateId, event.sourceId), eq(consents.status, 'granted')))
        let n = 0
        for (const s of subjects) {
          n += await projectWithFacts(
            tx,
            s.personaId,
            event.sourceId,
            {
              type: event.sourceType,
              snapshot: release.snapshot as { kind?: unknown; studyNameMode?: unknown },
              published: release.status === 'published',
              consented: true,
            },
            release.publishedAt ?? new Date(),
          )
        }
        return n
      }
    }
  })
}

/** 큐 만들기와 작업 등록. */
export async function registerPersonaActivityQueue(boss: PgBoss, db: DbExecutor): Promise<void> {
  await boss.createQueue(PERSONA_ACTIVITY_PROJECT_TOPIC, PUBLICATION_QUEUE_OPTIONS)
  await boss.updateQueue(PERSONA_ACTIVITY_PROJECT_TOPIC, PUBLICATION_QUEUE_OPTIONS)
  await boss.work<Record<string, unknown>>(PERSONA_ACTIVITY_PROJECT_TOPIC, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return
    const affected = await handlePersonaActivityProject(db, job.data)
    console.info(`[worker] persona_activity.project ${job.id}: affected=${affected}`)
  })
}
