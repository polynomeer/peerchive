/**
 * outbox 주제(topic)와 payload(ADR 0004). 웹이 상태 변경과 같은 트랜잭션에 outbox_events 행을 남기고, worker가 같은 이름의
 * pg-boss 큐로 옮겨 처리합니다. 웹과 worker가 같은 값을 쓰도록 여기 둡니다(두 쪽 모두 이 패키지에 의존).
 * payload에는 id·번호만 넣고 본문·이메일·이름은 넣지 않습니다.
 */

/** 공개 release 게시(T-12). worker의 검색 색인·유용성 신호 정리(T-13)와 포트폴리오(T-14)가 구독합니다. */
export const PUBLICATION_PUBLISHED_TOPIC = 'publication.published'
/** 공개 철회(owner 철회 또는 당사자 동의 철회, T-12). worker가 파생 데이터 정리 handler를 실행합니다. */
export const PUBLICATION_WITHDRAWN_TOPIC = 'publication.withdrawn'

export interface PublicationOutboxPayload {
  publicationId: string
  projectId: string
  /** 게시·철회된 release(publication_candidates 행). */
  releaseId: string
  releaseNo: number
  /** 이 이벤트 뒤의 publications.access_epoch. 정리 handler는 이 값보다 오래된 파생 행을 지웁니다. */
  accessEpoch: number
  /** 철회 원인(withdrawn만). restricted는 운영 조치로 공개를 제한한 경우(T-15, release도 withdrawn이 됨). */
  cause?: 'owner' | 'consent_revoked' | 'restricted'
  /** 게시가 대체한 이전 release(published만, 없으면 null). */
  replacedReleaseId?: string | null
}

/** 선배 노트 게시(T-13). worker가 검색 문서를 만듭니다. */
export const SENIOR_NOTE_PUBLISHED_TOPIC = 'senior_note.published'
/** 선배 노트 철회·게시 취소(고쳐서 draft로 돌아감, T-13). worker가 검색 문서·유용성 신호를 지웁니다. */
export const SENIOR_NOTE_WITHDRAWN_TOPIC = 'senior_note.withdrawn'

export interface SeniorNoteOutboxPayload {
  seniorNoteId: string
  courseId: string
  /** 이벤트 시점의 노트 version. 게시 handler는 지금 version이 같고 published일 때만 색인합니다. */
  version: number
}

/**
 * 운영 조치 적용·되돌림(T-15). worker가 남은 파생 데이터를 맞춥니다(가린 막힘 카드·숨긴 노트의 검색 문서 삭제, 되돌리면 다시 색인).
 * 공개 읽기는 이 이벤트를 기다리지 않습니다(요청마다 조치 상태를 확인). 공개 제한(restrict)은 `publication.withdrawn`(cause restricted)도 남깁니다.
 */
export const MODERATION_ACTION_TOPIC = 'moderation.action'

export interface ModerationActionOutboxPayload {
  actionId: string
  phase: 'applied' | 'reversed'
}

/** 막힘 Q&A 게시(C-09, ADR 0025). worker가 검색 문서를 만듭니다(지금도 published일 때만). */
export const COURSE_QA_PUBLISHED_TOPIC = 'course_qa.published'
/** 막힘 Q&A 철회(당사자 철회·탈퇴 정리). worker가 검색 문서·유용성 신호를 지웁니다. 공개 읽기는 이 이벤트를 기다리지 않습니다(status 확인). */
export const COURSE_QA_WITHDRAWN_TOPIC = 'course_qa.withdrawn'

export interface CourseQaOutboxPayload {
  courseQaItemId: string
  courseId: string
}

/**
 * 소셜 링크 되돌림 확인 요청(S-06, ADR 0034). 웹은 링크 행과 이 행만 남기고 URL에 접속하지 않습니다. worker의 링크 수집기(SSRF 방어)가 가져와
 * 상태를 바꿉니다. payload에는 링크 id만 넣습니다(주소 없음 — worker가 지금 행을 읽음).
 */
export const SOCIAL_LINK_VERIFY_TOPIC = 'social_link.verify'

export interface SocialLinkVerifyOutboxPayload {
  socialLinkId: string
}

/**
 * 페르소나 활동 투영 요청(S-05, ADR 0035, SYSTEM_DESIGN §6.7.1 PersonaActivity "원본 모듈이 outbox로 투영"). 원본 모듈이 원천을 처음 공개하는
 * 트랜잭션에서 남기고(커뮤니티 글 작성: real·display이고 페르소나가 고정된 listed 공간 글만, 선배 노트 게시: 익명이 아닌 것만, release 게시:
 * 익명 스터디가 아닌 것만), worker가 persona_activities에 넣습니다 — 선배 노트·release는 지금 원본 행을 다시 읽어 @peerchive/domain 규칙으로,
 * 커뮤니티 글은 커뮤니티 모듈이 판정해 넘긴 페르소나로(worker는 커뮤니티 테이블을 읽지 않음). 어느 쪽이든 DB 트리거가 원본 행으로 한 번 더 확인합니다.
 * 거두기(withdrawn_at)는 이 이벤트가 아니라 원본 상태가 바뀌는 같은 트랜잭션의 DB 트리거가 합니다. payload에는 원천 종류·id만.
 */
export const PERSONA_ACTIVITY_PROJECT_TOPIC = 'persona_activity.project'

export interface PersonaActivityProjectOutboxPayload {
  sourceType: 'publication_release' | 'senior_note' | 'study_release' | 'community_post'
  sourceId: string
  /**
   * 커뮤니티 글만: 작성 시점에 고정한 페르소나와 작성 시각. 커뮤니티 모듈이 자기 행으로 규칙을 판정해 넣고, worker는 커뮤니티 테이블을 읽지 않습니다
   * (C-05 경계: worker 파생 처리기는 커뮤니티 테이블에 닿지 않음). DB 트리거가 원본 행으로 다시 확인합니다.
   */
  personaId?: string
  occurredAt?: string
}
