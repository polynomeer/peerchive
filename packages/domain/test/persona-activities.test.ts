import { describe, expect, it } from 'vitest'
import {
  PERSONA_ACTIVITY_ITEM_KINDS,
  PERSONA_ACTIVITY_SOURCES,
  type PersonaActivitySourceFacts,
  type ProjectionPersona,
  decidePersonaActivityProjection,
  personaActivityItemKind,
  personaKindForNameMode,
} from '../src'

const REAL: ProjectionPersona = { id: 'p-real', kind: 'real' }
const DISPLAY: ProjectionPersona = { id: 'p-display', kind: 'display' }

const post = (over: Partial<Extract<PersonaActivitySourceFacts, { type: 'community_post' }>> = {}): PersonaActivitySourceFacts => ({
  type: 'community_post',
  nameMode: 'real',
  personaId: REAL.id,
  discovery: 'listed',
  published: true,
  ...over,
})

describe('decidePersonaActivityProjection (S-02: 0~1단계 투영 경로 없음)', () => {
  it('커뮤니티 글: real·display + 작성 시점 페르소나 + listed + 게시 중만 투영한다', () => {
    expect(decidePersonaActivityProjection(post(), REAL)).toEqual({ project: true, itemKind: 'posts' })
    expect(decidePersonaActivityProjection(post({ nameMode: 'display', personaId: DISPLAY.id }), DISPLAY)).toEqual({ project: true, itemKind: 'posts' })
    expect(decidePersonaActivityProjection(post({ nameMode: 'anonymous', personaId: null }), REAL)).toEqual({ project: false, reason: 'anonymous' })
    // 익명은 다른 조건보다 먼저(페르소나 id를 잘못 넘겨도 anonymous).
    expect(decidePersonaActivityProjection(post({ nameMode: 'anonymous', personaId: REAL.id }), REAL)).toEqual({ project: false, reason: 'anonymous' })
    expect(decidePersonaActivityProjection(post({ personaId: null }), REAL)).toEqual({ project: false, reason: 'no_persona' })
    expect(decidePersonaActivityProjection(post({ discovery: 'unlisted' }), REAL)).toEqual({ project: false, reason: 'unlisted_space' })
    expect(decidePersonaActivityProjection(post({ published: false }), REAL)).toEqual({ project: false, reason: 'not_published' })
  })

  it('표시명 글을 실명 페르소나에(또는 반대로) 붙이지 않는다', () => {
    expect(decidePersonaActivityProjection(post({ nameMode: 'display', personaId: DISPLAY.id }), REAL)).toEqual({ project: false, reason: 'persona_mismatch' })
    expect(decidePersonaActivityProjection(post({ nameMode: 'display', personaId: REAL.id }), REAL)).toEqual({ project: false, reason: 'persona_mismatch' })
    expect(decidePersonaActivityProjection(post({ nameMode: 'real', personaId: REAL.id }), DISPLAY)).toEqual({ project: false, reason: 'persona_mismatch' })
  })

  it('선배 노트: 익명은 없음, 계정 이름은 실명·표시명은 표시명 페르소나만', () => {
    const note = (displayMode: 'name' | 'display' | 'anonymous', published = true): PersonaActivitySourceFacts => ({ type: 'senior_note', displayMode, published })
    expect(decidePersonaActivityProjection(note('anonymous'), REAL)).toEqual({ project: false, reason: 'anonymous' })
    expect(decidePersonaActivityProjection(note('anonymous'), DISPLAY)).toEqual({ project: false, reason: 'anonymous' })
    expect(decidePersonaActivityProjection(note('name'), REAL)).toEqual({ project: true, itemKind: 'notes_and_studies' })
    expect(decidePersonaActivityProjection(note('name'), DISPLAY)).toEqual({ project: false, reason: 'persona_mismatch' })
    expect(decidePersonaActivityProjection(note('display'), DISPLAY)).toEqual({ project: true, itemKind: 'notes_and_studies' })
    expect(decidePersonaActivityProjection(note('display'), REAL)).toEqual({ project: false, reason: 'persona_mismatch' })
    expect(decidePersonaActivityProjection(note('name', false), REAL)).toEqual({ project: false, reason: 'not_published' })
  })

  it('공개 사례·스터디 release: 실명 페르소나만, 본인 동의, 익명 스터디 방은 없음', () => {
    const rel = (type: 'publication_release' | 'study_release', snapshot: object, over: object = {}) =>
      ({ type, snapshot, published: true, consented: true, ...over }) as PersonaActivitySourceFacts
    expect(decidePersonaActivityProjection(rel('publication_release', { kind: 'team' }), REAL)).toEqual({ project: true, itemKind: 'cases' })
    expect(decidePersonaActivityProjection(rel('publication_release', { kind: 'team' }), DISPLAY)).toEqual({ project: false, reason: 'display_persona' })
    expect(decidePersonaActivityProjection(rel('publication_release', { kind: 'team' }, { consented: false }), REAL)).toEqual({ project: false, reason: 'not_consented' })
    expect(decidePersonaActivityProjection(rel('publication_release', { kind: 'team' }, { published: false }), REAL)).toEqual({ project: false, reason: 'not_published' })
    expect(decidePersonaActivityProjection(rel('study_release', { kind: 'study', studyNameMode: 'display' }), REAL)).toEqual({ project: true, itemKind: 'notes_and_studies' })
    expect(decidePersonaActivityProjection(rel('study_release', { kind: 'study', studyNameMode: 'anonymous' }), REAL)).toEqual({ project: false, reason: 'anonymous' })
    // 익명 스터디 스냅샷은 공개 사례 원천으로 우회해도 anonymous.
    expect(decidePersonaActivityProjection(rel('publication_release', { kind: 'study', studyNameMode: 'anonymous' }), REAL)).toEqual({ project: false, reason: 'anonymous' })
    expect(decidePersonaActivityProjection(rel('publication_release', { kind: 'study', studyNameMode: 'real' }), REAL)).toEqual({ project: false, reason: 'source_kind' })
    expect(decidePersonaActivityProjection(rel('study_release', { kind: 'team' }), REAL)).toEqual({ project: false, reason: 'source_kind' })
  })

  it('프로필 글은 자기 페르소나에만', () => {
    expect(decidePersonaActivityProjection({ type: 'profile_post', ownPersonaId: DISPLAY.id }, DISPLAY)).toEqual({ project: true, itemKind: 'posts' })
    expect(decidePersonaActivityProjection({ type: 'profile_post', ownPersonaId: DISPLAY.id }, REAL)).toEqual({ project: false, reason: 'persona_mismatch' })
  })

  it('모든 조합에서 익명 원천은 어떤 페르소나에도 투영되지 않는다(전수)', () => {
    let checked = 0
    for (const persona of [REAL, DISPLAY])
      for (const personaId of [null, REAL.id, DISPLAY.id, 'other'])
        for (const discovery of ['listed', 'unlisted'] as const)
          for (const published of [true, false]) {
            expect(decidePersonaActivityProjection(post({ nameMode: 'anonymous', personaId, discovery, published }), persona).project).toBe(false)
            expect(decidePersonaActivityProjection({ type: 'senior_note', displayMode: 'anonymous', published }, persona).project).toBe(false)
            for (const consented of [true, false])
              for (const type of ['publication_release', 'study_release'] as const)
                expect(decidePersonaActivityProjection({ type, snapshot: { kind: 'study', studyNameMode: 'anonymous' }, published, consented }, persona).project).toBe(false)
            checked++
          }
    expect(checked).toBe(32)
  })

  it('항목 종류와 방식 → 페르소나 종류 대응', () => {
    expect(PERSONA_ACTIVITY_SOURCES.map(personaActivityItemKind)).toEqual(['cases', 'notes_and_studies', 'notes_and_studies', 'posts', 'posts'])
    expect(PERSONA_ACTIVITY_ITEM_KINDS).toEqual(['cases', 'notes_and_studies', 'posts'])
    expect(personaKindForNameMode('real')).toBe('real')
    expect(personaKindForNameMode('display')).toBe('display')
    expect(personaKindForNameMode('anonymous')).toBeNull()
  })
})
