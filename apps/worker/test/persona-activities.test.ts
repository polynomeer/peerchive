/**
 * 페르소나 활동 투영 처리기의 payload 검사(S-05, ADR 0035). 원천별 투영·거두기는 web의 feed.integration.test.ts와 S-02 속성 테스트가
 * 이 처리기를 직접 불러 확인합니다.
 */
import { describe, expect, it } from 'vitest'
import { parsePersonaActivityPayload } from '../src/persona-activities'

describe('persona_activity.project payload', () => {
  const id = '3cebb755-e2d5-48f1-a70d-2180334c24f7'
  it('accepts the four outbox sources with a uuid; community posts also need the persona and time the community module decided', () => {
    for (const sourceType of ['senior_note', 'publication_release', 'study_release'] as const)
      expect(parsePersonaActivityPayload({ sourceType, sourceId: id.toUpperCase() })).toEqual({ sourceType, sourceId: id })
    const post = { sourceType: 'community_post', sourceId: id, personaId: id, occurredAt: '2026-11-10T09:00:00.000Z' }
    expect(parsePersonaActivityPayload(post)).toEqual(post)
    // 커뮤니티 글에 페르소나·시각이 없으면 처리하지 않습니다(worker는 커뮤니티 테이블을 읽지 않으므로 채울 길이 없음).
    expect(parsePersonaActivityPayload({ sourceType: 'community_post', sourceId: id })).toBeNull()
    expect(parsePersonaActivityPayload({ ...post, personaId: 'x' })).toBeNull()
    expect(parsePersonaActivityPayload({ ...post, occurredAt: 'yesterday' })).toBeNull()
    // 프로필 글은 social이 같은 트랜잭션에서 직접 투영하므로 outbox 원천이 아닙니다.
    for (const bad of [null, 'x', {}, { sourceType: 'profile_post', sourceId: id }, { sourceType: 'community_post', sourceId: 'nope' }, { sourceType: 'comment', sourceId: id }])
      expect(parsePersonaActivityPayload(bad), JSON.stringify(bad)).toBeNull()
  })
})
