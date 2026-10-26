# 0017. 배포 준비: 공급자 무관 SMTP 메일 transport + S3 호환 저장소 driver

- 상태: 채택
- 날짜: 2026-10-26
- 관련: [0006](0006-auth-sessions.md)(메일 transport), [0007](0007-file-storage-and-scanning.md)(저장소·검사·메타데이터 제거), [0012](0012-publish-withdraw-public-read.md)(공개 내용 경로), [0016](0016-deletion-ledger-maintenance-analytics.md)(정리·백업)

## 맥락

배포 점검표(RUNBOOK §1)의 두 차단 항목이 남아 있었습니다. 메일은 개발용 `dev-console`뿐이라 production에서 web이 시작되지 않고, 파일 저장소는 filesystem driver뿐이라 단일 서버 예외(`PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION=1`) 없이는 web·worker가 시작되지 않습니다.

메일·저장소 공급자는 아직 고르지 않았고(DELIVERY_PLAN §10), 이번 작업에서도 고르지 않습니다. 어떤 SMTP 서버와 어떤 S3 호환 서비스(AWS S3, Cloudflare R2, MinIO 등)와도 동작해야 하고, 로컬·CI에서 공급자 계정 없이 같은 경로를 검증해야 합니다.

## 결정

### 메일: `smtp` transport (nodemailer)

- `MailTransport` 구현 `smtp`를 추가합니다. 표준 SMTP만 쓰며 공급자별 API(SES API, 공급자 SDK)는 쓰지 않습니다. 의존성은 `nodemailer`(10.1.0, 자체 타입 포함) 하나입니다.
- 설정: `PEERCHIVE_MAIL_TRANSPORT=smtp`(없으면 기존 `NUXT_MAIL_TRANSPORT`), `PEERCHIVE_SMTP_URL`(`smtps://user:pass@host:465` 또는 `smtp://user:pass@host:587`) 또는 `PEERCHIVE_SMTP_HOST`/`_PORT`/`_SECURE`/`_USER`/`_PASSWORD`(둘 다 쓰면 거부), `PEERCHIVE_MAIL_FROM`(필수), `PEERCHIVE_MAIL_REPLY_TO`(선택). 시작할 때 형식을 검사하고(접속은 하지 않음) 오류 메시지에는 변수 이름만 넣습니다.
- **TLS**: `smtps://`는 처음부터 TLS, `smtp://`는 STARTTLS를 요구합니다(`requireTLS`, 서버가 지원하지 않으면 실패). 인증서 검증은 끌 수 없고 TLS 1.2 이상입니다. TLS 없는 SMTP는 `PEERCHIVE_SMTP_ALLOW_INSECURE=1`일 때만이며(로컬 Mailpit 전용) production에서는 이 표시가 있으면 시작하지 않습니다.
- **연결**: 연결 풀 없음(메일마다 연결·종료), 연결 10초·인사 10초·유휴 20초 시간 제한. nodemailer 로거·디버그는 끄고(SMTP 대화에 주소·본문이 있음), 파일·URL 첨부 읽기도 끕니다.
- **메시지**: 일반 텍스트 + 같은 내용의 단순 HTML(`lang="ko"`, 문구는 기존 그대로). 링크는 지금과 같은 `<origin>/auth/verify#token=…`(fragment). 헤더: 보내는 도메인으로 만든 `Message-ID`, `Date`, `Auto-Submitted: auto-generated`(RFC 3834), `X-Auto-Response-Suppress: All`. 트랜잭션 메일이라 `List-Unsubscribe`는 넣지 않습니다.
- **로그**: 성공 시 `[mail:smtp] sent to=a***@domain` 한 줄. 실패는 `MailSendError`(nodemailer 오류 코드·SMTP 응답 코드·명령 이름만)로 바꿔 던지며 서버 응답 원문(수신 주소가 들어 있을 수 있음)과 원래 오류는 담지 않습니다.
- **실패 처리**: 매직링크 요청은 발송을 기다리지만 실패해도 같은 202입니다(계정 열거 방지). `[auth] magic link mail failed (transport, code, responseCode)` 로그와 감사 이벤트 `mail.send_failed`(target `mail`, metadata `purpose`·`transport`·`code`·`responseCode`, 주소 없음)를 남깁니다. 토큰 행은 그대로 두며 15분 뒤 만료됩니다.
- **재시도 큐는 두지 않습니다**: outbox로 재시도하려면 링크(토큰 원문)를 DB에 남겨야 하고, 늦게 도착한 링크는 15분 만료로 쓸모가 줄어듭니다. 사용자가 다시 요청하는 편이 단순하고 안전합니다. 실패 빈도는 감사 이벤트로 봅니다.
- **production 규칙**: production에서는 올바르게 설정된 `smtp`만 허용합니다. `dev-console`, 모르는 이름, smtp 설정 누락·형식 오류, insecure 표시는 모두 시작 시 예외입니다(server/plugins/mail.ts).

### 저장소: `s3` driver (AWS SDK v3)

- `ObjectStorage` 구현 `S3Storage`(`@peerchive/files`의 `s3-storage.ts`)를 추가합니다. 인터페이스·키 규칙은 그대로입니다(`quarantine/<uuid>`·`clean/<uuid>`만, 다른 키는 모든 메서드가 네트워크 요청 전에 거부). 의존성은 `@aws-sdk/client-s3`(3.1149.0) 하나이며 서명 URL을 만들지 않으므로 presigner는 넣지 않았습니다.
- 설정: `PEERCHIVE_STORAGE_DRIVER=s3`, `PEERCHIVE_S3_ENDPOINT`(origin만, 생략하면 AWS 기본), `PEERCHIVE_S3_REGION`(R2는 `auto`), `PEERCHIVE_S3_BUCKET`, `PEERCHIVE_S3_ACCESS_KEY_ID`/`PEERCHIVE_S3_SECRET_ACCESS_KEY`(필수, 기본 자격 증명 체인은 쓰지 않음), `PEERCHIVE_S3_FORCE_PATH_STYLE=1`(MinIO), `PEERCHIVE_S3_PREFIX`(선택, 소문자·숫자·`._-`와 `/`). web과 worker(운영 명령 포함)가 같은 `resolveObjectStorage`로 읽습니다.
- **put**: 본문을 최대 `maxBytes`(업로드 한도 20MB, driver 상한 32MiB)까지 메모리에 모으며 SHA-256을 계산하고, 다 받은 뒤 한 번의 `PutObject`로 씁니다. 한도를 넘는 순간 읽기를 멈추고 아무것도 올리지 않으므로 지울 조각이 없습니다. multipart를 쓰지 않은 이유: 파일이 작고(20MB), 검사 작업도 같은 크기를 메모리에 올리며(ADR 0007), 중단된 multipart 조각 정리(Abort·수명 주기 규칙)가 필요 없어집니다. 대가는 업로드 하나당 최대 20MB의 web 메모리입니다.
- **덮어쓰기 금지**: `If-None-Match: *` 조건부 쓰기(AWS S3·R2·MinIO 지원, 412면 거부)와, 조건을 무시하는 구현에 대비한 쓰기 전 `head`를 함께 씁니다. 키는 무작위 UUID라 충돌은 같은 의도에 두 번 보낸 경우뿐입니다.
- **get**: `GetObject`(+ `Range: bytes=start-end`) 스트림을 그대로 돌려줍니다. 없으면 `ObjectNotFoundError`, 범위가 내용 밖이면(416) 빈 스트림(filesystem과 같음).
- **copy/move**: `CopyObject`. move는 copy 뒤 delete라 **원자적이지 않습니다**. 대상 키 교체 자체는 원자적이라(S3는 객체를 통째로 바꿈, 강한 read-after-write 일관성) 읽는 쪽은 이전 내용 또는 새 내용만 봅니다. copy 뒤 delete 전에 죽으면 원본이 남는데, move의 원본은 언제나 격리 키(`writeObject`의 임시 키, 검사 전 업로드)라 내려주지 않으며, 어떤 버전·의도도 가리키지 않으면 주인 없는 격리 파일 정리(24시간 뒤, ADR 0016)가 지웁니다. 원본이 없고 대상이 있으면 이미 옮긴 것으로 보고 성공합니다(재실행 안전).
- **검사 작업 순서와 안전성**: 검사 통과 → `writeObject`(새 격리 키에 put → clean 키로 move) → DB를 clean으로 → 격리 원본 삭제. 어느 단계에서 죽어도 clean 키에는 온전한 내용만 있고, DB가 clean이 되기 전에는 아무도 내려받지 못하며, 재실행은 격리 원본에서 같은 결과를 다시 씁니다(ADR 0007과 같은 순서, driver와 무관).
- **delete**: `DeleteObject`(없어도 성공). **list**: `ListObjectsV2` 페이지 넘김(기본 1000개), 서버 형식이 아닌 키는 건너뜀.
- **요청 설정**: 연결 5초·소켓 유휴 30초, 최대 3회 시도. SDK의 새 기본 체크섬 헤더(CRC32 등)는 일부 S3 호환 서비스가 거부하므로 필요한 요청에만 붙입니다(`WHEN_REQUIRED`). 무결성은 우리가 계산한 SHA-256(DB)과 검사 작업의 재확인으로 봅니다.
- **비공개**: 버킷은 비공개여야 하고 driver는 공개 URL·서명 URL을 만들지 않습니다. 내려받기는 지금처럼 권한·검사 상태를 확인한 서버 경로(비공개 `/api/v1/artifacts/…/content`, 공개 `/api/v1/public/…`)가 스트림으로 내려줍니다. 브라우저가 버킷에 직접 접근하지 않으므로 CORS 설정이 필요 없습니다.
- **production 규칙**: `s3`는 필수 값이 모두 있고 endpoint가 https일 때만 허용합니다(http endpoint는 production에서 거부, 우회 표시 없음). `filesystem`은 기존 허용 표시가 있을 때만입니다. 설정 검사만 하고 시작 시 접속하지는 않습니다. 접속 확인은 운영자용 `GET /api/v1/health?deep=1`(쓰기·읽기·지우기 시험)입니다.

### 백업

- `ops/backup.sh`는 `PEERCHIVE_STORAGE_DRIVER=s3`이면 파일을 tar로 묶지 않고 빈 `storage.tar.gz`와 manifest `storage=s3-provider-side`만 남깁니다(복구 스크립트 형식 유지, 삭제 동작 변경 없음). 파일 백업은 공급자 쪽 버킷 버전 관리 + 이전 버전 보존 규칙(+ 가능하면 복제)으로 합니다(RUNBOOK §1.1·§5). `ops/restore.sh`는 그런 백업이면 안내를 출력하고, `ops/restore-drill.sh`의 재적용 단계는 언제나 임시 filesystem 저장소를 봐 운영 버킷을 건드리지 않습니다.

### 로컬·테스트

- `ops/docker-compose.yml`에 profile 서비스 `mailpit`(axllent/mailpit:v1.31.4, 127.0.0.1:1025 SMTP·8025 웹/API)과 `minio`(minio/minio:RELEASE.2025-09-07T16-13-09Z, 127.0.0.1:9000 API·9001 관리 화면, 로컬 전용 계정)를 추가합니다. profile을 지정할 때만 뜹니다.
- 저장소 테스트를 공통 계약 테스트(`packages/files/test/storage-contract.ts`)로 묶어 filesystem과 MinIO에 같이 돌립니다. 키 검사, 크기 한도와 정리, SHA-256, 범위 읽기, 덮어쓰기 move, 목록 페이지, 멱등 삭제, writeObject. S3 통합 테스트는 `PEERCHIVE_TEST_S3_*`, Mailpit 테스트는 `PEERCHIVE_TEST_MAILPIT_*`가 있을 때만 돌고, 루프백 주소만 받으며 테스트마다 무작위 prefix·수신 주소를 씁니다.

## 결과

- 배포 점검표의 메일·저장소 항목은 "구현됨 — 공급자 설정 필요"가 됩니다. production은 실제 SMTP(TLS)와 비공개 S3 호환 버킷 설정 없이는 시작하지 않습니다.
- 공급자마다 남는 일(코드 밖, RUNBOOK §1.1): 메일 발송 도메인 인증과 DNS SPF·DKIM·DMARC, SMTP 전용 자격 증명, 발송 한도·반송 알림. 저장소는 비공개 버킷, 그 버킷 전용 키, 버전 관리·이전 버전 보존 규칙(·복제), 저장 시 암호화 확인. 버킷 정책으로 공개 접근을 막는 것 말고 CORS·공개 정책은 필요 없습니다.
- 알려진 한계(TODO):
  - 서명 URL 직접 업로드·내려받기는 하지 않았습니다(나중의 최적화). 지금은 모든 바이트가 web을 지나므로 web의 대역폭·메모리(업로드당 최대 20MB)가 한계입니다. 바꿀 때는 ADR 0007의 3단계 API 모양을 유지하고, 짧은 만료·`Content-Type` 고정·완료 단계의 `head` 크기 확인과 검사 작업의 해시 재확인을 둡니다.
  - 메일 재시도 큐가 없습니다. 반송(bounce)·수신 거부 주소 자동 처리가 없습니다.
  - DKIM 서명은 공급자(SMTP 릴레이)가 한다고 가정합니다. 자체 DKIM 서명은 하지 않습니다.
  - 버킷이 실제로 비공개인지 시작 시 확인하지 않습니다(공급자마다 API가 다름). 운영자가 RUNBOOK §1.1에서 확인합니다.
  - 조건부 쓰기를 지원하지 않는 S3 호환 구현에서는 덮어쓰기 금지가 head 확인(경합 가능)에만 기댑니다. 키가 무작위라 실제 위험은 같은 의도의 동시 PUT뿐이고, 이 경우도 업로드 완료 단계가 해시를 기록합니다.
  - MinIO 공식 이미지 배포 방식이 바뀌어 위 태그를 새로 받지 못할 수 있습니다. 그러면 다른 S3 호환 시험 서버(태그 고정)로 바꾸고 테스트 변수만 맞추면 됩니다.

## 대안

- 공급자 HTTP API(SES·Postmark·Resend 등) transport: 반송·지표 기능이 좋지만 공급자에 묶입니다. SMTP는 거의 모든 공급자가 지원하고 Mailpit으로 그대로 시험할 수 있습니다. 공급자를 고른 뒤 필요하면 같은 인터페이스로 추가합니다.
- 메일 발송을 outbox·worker로 비동기화: 요청 지연은 줄지만 토큰 원문이 DB·큐에 남습니다. 매직링크는 짧게 살아야 하므로 요청 안에서 보냅니다.
- multipart 스트리밍 업로드(`@aws-sdk/lib-storage`): 메모리는 줄지만 의존성이 늘고, 한도 초과·중단 시 조각 정리(Abort, 수명 주기 규칙)가 필요합니다. 파일당 20MB에서는 이득이 작습니다.
- 서명 URL로 바로 전환: web 부하는 줄지만 업로드 PUT의 크기 강제(서명 조건)·내려받기 헤더(nosniff·sandbox CSP·Content-Disposition)·요청마다의 권한 재확인(공개 철회 즉시 반영, ADR 0012)을 서명 URL 쪽에서 다시 맞춰야 합니다. 지금은 프록시 스트림이 더 안전합니다.
- 공급자별 SDK(R2 Workers 바인딩 등): 특정 공급자에 묶이므로 쓰지 않습니다.
