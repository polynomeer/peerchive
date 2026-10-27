/**
 * 정체성 분리 경계: 페르소나 활동 투영 규칙 (S-02, SYSTEM_DESIGN §6.7.1 PersonaActivity·"글의 페르소나 귀속"·"기존 규칙과의 관계"·§8.3 불변조건 1,
 * DELIVERY_PLAN §4.2 S-02·§5.2 Q, ADR 0029).
 *
 * - 공개 프로필의 활동 목록과 팔로우 피드(S-05)는 `PersonaActivity`만 읽습니다. 이 파일은 **어떤 원천을 어느 페르소나에 투영해도 되는지**만 정합니다.
 * - 0~1단계(익명) 글은 투영 경로가 없습니다: 커뮤니티 글은 이름 표시 방식이 real·display이고 작성 시점에 고정한 페르소나가 있고 listed 공간의
 *   게시 중인 글만, 익명 선배 노트·익명 스터디 방 release는 어떤 페르소나에도 투영하지 않습니다.
 * - 같은 규칙을 DB 트리거(persona_activities_projection_guard, migration 0027)가 원본 행으로 다시 확인합니다. 이 함수는 원본 모듈이 투영을
 *   시도하기 전에 거르고 거부 이유를 코드로 돌려주는 쪽입니다.
 *
 * 런타임 의존성 없음.
 */
import type { PersonaKind } from './personas'

export const PERSONA_ACTIVITY_SOURCES = ['publication_release', 'senior_note', 'study_release', 'profile_post', 'community_post'] as const
export type PersonaActivitySource = (typeof PERSONA_ACTIVITY_SOURCES)[number]

/** 공개 범위 항목(§6.7.1 VisibilitySetting) 대응. 공개 사례는 공개 범위 설정의 대상이 아니라 따로 둡니다(§8.3 불변조건 2). */
export const PERSONA_ACTIVITY_ITEM_KINDS = ['cases', 'notes_and_studies', 'posts'] as const
export type PersonaActivityItemKind = (typeof PERSONA_ACTIVITY_ITEM_KINDS)[number]

const ITEM_KIND: Readonly<Record<PersonaActivitySource, PersonaActivityItemKind>> = {
  publication_release: 'cases',
  senior_note: 'notes_and_studies',
  study_release: 'notes_and_studies',
  profile_post: 'posts',
  community_post: 'posts',
}

/** 원천 종류의 항목 종류(DB check persona_activities_item_kind_check와 같은 대응). */
export function personaActivityItemKind(source: PersonaActivitySource): PersonaActivityItemKind {
  return ITEM_KIND[source]
}

/** 커뮤니티 이름 표시 방식(C-03) → 그 글이 귀속될 페르소나 종류. anonymous(0단계)는 페르소나가 없습니다. */
export function personaKindForNameMode(mode: 'real' | 'display' | 'anonymous'): PersonaKind | null {
  return mode === 'anonymous' ? null : mode
}

/** 투영 대상 페르소나(원본 모듈이 고른 것). */
export interface ProjectionPersona {
  id: string
  kind: PersonaKind
}

/** 원천의 사실(원본 모듈이 자기 테이블에서 읽어 넘김). social 모듈은 원본 테이블을 읽지 않습니다. */
export type PersonaActivitySourceFacts =
  | {
      type: 'community_post'
      nameMode: 'real' | 'display' | 'anonymous'
      /** 글에 작성 시점에 고정한 페르소나(community_posts.persona_id). */
      personaId: string | null
      discovery: 'listed' | 'unlisted'
      published: boolean
    }
  | { type: 'senior_note'; displayMode: 'name' | 'display' | 'anonymous'; published: boolean }
  | { type: 'publication_release'; snapshot: { kind?: unknown; studyNameMode?: unknown }; published: boolean; consented: boolean }
  | { type: 'study_release'; snapshot: { kind?: unknown; studyNameMode?: unknown }; published: boolean; consented: boolean }
  | { type: 'profile_post'; ownPersonaId: string; published: boolean }

export type ProjectionRefusal =
  | 'anonymous'
  | 'no_persona'
  | 'persona_mismatch'
  | 'unlisted_space'
  | 'not_published'
  | 'not_consented'
  | 'display_persona'
  | 'source_kind'

export type ProjectionDecision = { project: true; itemKind: PersonaActivityItemKind } | { project: false; reason: ProjectionRefusal }

const refuse = (reason: ProjectionRefusal): ProjectionDecision => ({ project: false, reason })

/**
 * 원천을 이 페르소나의 활동으로 투영해도 되는지. 익명(0단계)은 다른 조건보다 먼저 `anonymous`로 거부합니다.
 * - community_post: 방식 real·display + 작성 시점 페르소나가 이 페르소나(종류도 방식과 같음) + listed 공간 + 게시 중.
 * - senior_note: 익명 거부, name → 실명 페르소나만, display → 표시명 페르소나만, 게시 중.
 * - publication_release·study_release: 실명 페르소나만(스냅샷에 계정 이름·팀 정보, ADR 0028), 본인 동의, 게시 중. 스터디 release는
 *   익명 스터디 방이면 `anonymous`(ADR 0026), 공개 사례 원천에 스터디 스냅샷을 넣거나 그 반대면 `source_kind`.
 * - profile_post: 자기 페르소나의 게시 중인 글만(S-05).
 */
export function decidePersonaActivityProjection(source: PersonaActivitySourceFacts, persona: ProjectionPersona): ProjectionDecision {
  const ok = (): ProjectionDecision => ({ project: true, itemKind: personaActivityItemKind(source.type) })
  switch (source.type) {
    case 'community_post': {
      const kind = personaKindForNameMode(source.nameMode)
      if (kind === null) return refuse('anonymous')
      if (source.personaId === null) return refuse('no_persona')
      if (source.personaId !== persona.id || kind !== persona.kind) return refuse('persona_mismatch')
      if (source.discovery !== 'listed') return refuse('unlisted_space')
      if (!source.published) return refuse('not_published')
      return ok()
    }
    case 'senior_note': {
      if (source.displayMode === 'anonymous') return refuse('anonymous')
      const kind: PersonaKind = source.displayMode === 'name' ? 'real' : 'display'
      if (kind !== persona.kind) return refuse('persona_mismatch')
      if (!source.published) return refuse('not_published')
      return ok()
    }
    case 'publication_release':
    case 'study_release': {
      const isStudy = source.snapshot.kind === 'study'
      if (isStudy && source.snapshot.studyNameMode === 'anonymous') return refuse('anonymous')
      if (isStudy !== (source.type === 'study_release')) return refuse('source_kind')
      if (persona.kind !== 'real') return refuse('display_persona')
      if (!source.published) return refuse('not_published')
      if (!source.consented) return refuse('not_consented')
      return ok()
    }
    case 'profile_post':
      if (source.ownPersonaId !== persona.id) return refuse('persona_mismatch')
      return source.published ? ok() : refuse('not_published')
  }
}
