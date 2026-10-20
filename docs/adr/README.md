# 아키텍처 결정 기록 (ADR)

Peerchive 신규 앱(`apps/`, `packages/`)의 기술 결정을 짧게 남깁니다. 배경 설계는 [시스템 설계](../planning/SYSTEM_DESIGN.md)를 따릅니다.

형식: 맥락 / 결정 / 결과 / 대안. 결정을 바꿀 때는 기존 ADR을 고치지 않고 새 ADR을 추가해 이전 것을 `대체됨`으로 표시합니다.

| 번호 | 제목 | 상태 |
|---|---|---|
| [0001](0001-new-app-alongside-archive.md) | 원본 아카이브 옆에 신규 앱을 만든다 | 채택 |
| [0002](0002-nuxt-monolith.md) | Nuxt 단일 앱(웹 + 서버 API) | 채택 |
| [0003](0003-postgresql-drizzle.md) | PostgreSQL + Drizzle ORM | 채택 |
| [0004](0004-pg-boss-jobs.md) | 비동기 작업은 pg-boss + outbox | 채택 |
| [0005](0005-node-version.md) | Node.js 런타임 버전 고정 | 채택 |
| [0006](0006-auth-sessions.md) | 인증: 이메일 매직링크 + 자체 DB 세션(표준 방식) | 채택 |
| [0007](0007-file-storage-and-scanning.md) | 파일 저장·격리·검사: 저장소 추상화 + 3단계 업로드 + worker 검사 | 채택 |
| [0008](0008-contribution-report-format.md) | 동료평가 리포트 형식: 인쇄용 HTML 페이지(브라우저 "PDF로 저장") | 채택 |
| [0009](0009-discord-bot-and-checkins.md) | 디스코드 봇과 주간 체크인: 별도 봇 프로세스 + 서명된 내부 API | 채택 |
| [0010](0010-catalog-merge-and-embargo.md) | 학교·과목·개념 태그 정규화와 엠바고: 운영자 테이블 + 즉시 다시 가리키는 병합 + 단조 엠바고 | 채택 |
| [0011](0011-publication-snapshot-and-consent.md) | 공개 후보와 동의: 저장된 공개 스냅샷 + manifest 해시에 묶인 동의 | 채택 |
| [0012](0012-publish-withdraw-public-read.md) | 게시·철회·익명 공개 조회: 트랜잭션 재검사 + 요청마다 DB 상태 확인(no-store) + 운영 스위치 | 채택 |
