# 아키텍처 결정 기록 (ADR)

Peerchive 신규 앱(`apps/`, `packages/`)의 기술 결정을 짧게 남깁니다. 배경 설계는 [시스템 설계](../planning/SYSTEM_DESIGN.md)를 따릅니다.

형식: 맥락 / 결정 / 결과 / 대안. 결정을 바꿀 때는 기존 ADR을 고치지 않고 새 ADR을 추가해 이전 것을 `대체됨`으로 표시합니다.

| 번호 | 제목 | 상태 |
|---|---|---|
| [0001](0001-new-app-alongside-archive.md) | 원본 아카이브 옆에 신규 앱을 만든다 | 채택 |
| [0002](0002-nuxt-monolith.md) | Nuxt 단일 앱(웹 + 서버 API) | 채택 |
| [0003](0003-postgresql-drizzle.md) | PostgreSQL + Drizzle ORM | 채택 |
| [0004](0004-pg-boss-jobs.md) | 비동기 작업은 pg-boss + outbox | 채택(구현 전) |
| [0005](0005-node-version.md) | Node.js 런타임 버전 고정 | 채택 |
| [0006](0006-auth-sessions.md) | 인증: 이메일 매직링크 + 자체 DB 세션(표준 방식) | 채택 |
