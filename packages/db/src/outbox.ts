/**
 * outbox 주제(topic)와 payload(ADR 0004). 웹이 상태 변경과 같은 트랜잭션에 outbox_events 행을 남기고, worker가 같은 이름의
 * pg-boss 큐로 옮겨 처리합니다. 웹과 worker가 같은 값을 쓰도록 여기 둡니다(두 쪽 모두 이 패키지에 의존).
 * payload에는 id·번호만 넣고 본문·이메일·이름은 넣지 않습니다.
 */

/** 공개 release 게시(T-12). 이후 검색 색인·과목 집계(T-13)·포트폴리오(T-14)가 구독합니다. */
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
  /** 철회 원인(withdrawn만). */
  cause?: 'owner' | 'consent_revoked'
  /** 게시가 대체한 이전 release(published만, 없으면 null). */
  replacedReleaseId?: string | null
}
