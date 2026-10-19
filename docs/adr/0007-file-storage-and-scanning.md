# 0007. 파일 저장·격리·검사: 저장소 추상화 + 3단계 업로드 + worker 검사

- 상태: 채택
- 날짜: 2026-10-19

## 맥락

T-05는 과제 산출물 파일을 올리고, 검사를 통과하기 전에는 누구도 열 수 없게 하며, 빌드 로그의 근거로 붙이게 합니다. SYSTEM_DESIGN §10은 비공개 S3 호환 저장소, 원 파일명으로 경로를 만들지 않음, `pending → scanning → clean / quarantined / failed`, 허용 MIME·확장자·실제 signature·용량을 함께 검사, 실행·압축·HTML/SVG 금지, 학생당 500MB·파일당 20MB를 요구합니다. 작업 큐는 ADR 0004(pg-boss + outbox)를 따릅니다.

아직 운영 저장소 계정(R2 등)이 없고, 로컬 개발과 CI에서 같은 흐름을 검증해야 합니다.

## 결정

### 저장소

- `ObjectStorage` 인터페이스(`@peerchive/files`): `put(key, stream, {maxBytes})`(크기·SHA-256 반환, 한도 초과 시 중단·삭제), `get(key, range?)`, `head`, `copy`, `move`, `delete`.
- 키는 서버가 만든 `quarantine/<uuid>`(검사 전) 또는 `clean/<versionId>`(검사 통과)뿐입니다. 다른 형식의 키는 모든 메서드가 거부하므로 사용자 입력·원 파일명이 경로가 될 수 없습니다. 파일 이름은 표시·내려받기 이름으로만 DB에 둡니다.
- 지금 구현은 **파일시스템 driver**입니다. 루트는 `PEERCHIVE_STORAGE_ROOT`(기본 저장소 루트의 `.data/objects`, gitignore 대상), 디렉터리 0700·파일 0600, 임시 파일에 쓴 뒤 link로 확정(같은 키 덮어쓰기 불가), 결과 경로가 루트 안인지 한 번 더 확인합니다. 이 디렉터리는 어떤 정적 경로로도 공개하지 않습니다.
- production에서는 `PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION=1`이 없으면 filesystem driver로 web·worker가 시작되지 않습니다(ADR 0006의 메일 transport와 같은 방식).
- **배포 전에 S3 호환(R2) driver를 추가합니다.** 인터페이스는 그대로 두고, PUT 단계를 짧은(60초 이하) 서명 URL 업로드로 바꾼 뒤 완료 단계에서 `head`로 크기를 확인하고, 내려받기는 권한·상태 확인 뒤 짧은 서명 URL이나 프록시 스트림으로 줍니다.

### 업로드 3단계 (서명 URL로 바꿔도 API 모양 유지)

1. `POST /api/v1/projects/:id/artifacts/upload-intents {fileName, declaredType, byteSize, clientId?, artifactId?}` — active owner/editor(`canUploadArtifact`)만. 허용 형식(PNG·JPEG·WebP·GIF·PDF)과 확장자 일치, 파일당 20MB, 사용자 한도 500MB를 확인하고 15분짜리 의도와 격리 키를 만듭니다. `{intentId, uploadUrl, completeUrl, byteSize, expiresAt}`를 돌려주며 `uploadUrl`은 지금은 이 서버의 PUT 주소입니다. 같은 `clientId`는 같은 의도를 돌려줍니다.
2. `PUT /api/v1/uploads/:intentId` — 의도를 만든 사용자만(CSRF Origin 검사 적용). 본문을 격리 키에 스트림으로 쓰며 SHA-256을 계산하고, 선언 크기를 넘는 순간 중단합니다. Content-Length가 선언과 다르면 읽기 전에 거부합니다.
3. `POST /api/v1/uploads/:intentId/complete` — idempotent. 산출물(새로 또는 `artifactId`)에 버전을 `pending`으로 만들고(판별 형식·크기·SHA-256 기록), 같은 트랜잭션에 검사 작업을 outbox에 남깁니다. 같은 산출물에 같은 SHA-256 버전이 있으면 그 버전을 돌려주고 받은 내용은 지웁니다(DB unique로도 막음).

### 검사

- worker(`apps/worker`)가 outbox 행을 pg-boss 작업(`artifact-scan`)으로 옮기고(행 id = 작업 id라 중복 없음) 처리합니다. 테스트는 `scanArtifactVersion`을 직접 부릅니다.
- 순서: 크기·SHA-256 재확인 → 자체 magic-byte 판별(의존성 없음) → 선언 형식·확장자와 대조(`decideFileType`) → 내장 콘텐츠 점검(이미지 앞부분의 HTML/SVG/스크립트 태그, 파일 끝 ZIP 레코드, PDF의 JavaScript·Launch·EmbeddedFiles·RichMedia·XFA, `#xx` 이스케이프 해제 후) → 악성코드 검사.
- SVG·HTML·XML·ZIP/Office·OLE·실행 파일·스크립트·판별 불가는 격리하고 사유 코드를 남깁니다(`disallowed_type`, `unknown_type`, `type_mismatch`, `extension_mismatch`, `embedded_content`, `pdf_active_content`, `malware`).
- `MalwareScanner` 인터페이스: `clamav`(clamd INSTREAM, TCP, `CLAMAV_HOST`/`CLAMAV_PORT`)와 개발 전용 `signature-only`(형식 판별만, EICAR 시험 문자열만 인식). production에서는 `signature-only`로 worker가 시작되지 않습니다. 로컬 clamd는 `docker compose --profile clamav`로 띄웁니다. `scan_engine`, `scanned_at`, `scan_attempts`를 기록합니다.
- 상태 전이는 순수 함수 `nextScanStatus`로 고정합니다. clean·quarantined는 최종 상태라 중복 실행이 결과를 뒤집지 않습니다. 통과하면 `clean/<versionId>`로 옮긴 뒤 DB를 바꾸므로, 그 사이에 죽어도 재실행이 같은 결과로 끝납니다. 격리 파일은 격리 키에 그대로 두고 내려주지 않습니다.
- 재시도: 최대 5회, 30초부터 지수 backoff(최대 30분), 작업 만료 5분, 실패 시 `artifact-scan-dead` 큐로(dead-letter). 검사기 오류는 마지막 시도 전까지 `scanning`으로 두고, 마지막 시도에서 `failed`. 내용이 없거나 해시가 다르면 바로 `failed`. 사용자는 `failed`만 다시 검사 요청할 수 있습니다(`POST /artifacts/:id/versions/:versionId/rescan`).

### 열람

- `GET /api/v1/artifacts/:id/versions/:versionId/content` — 같은 프로젝트 active 멤버이고 `clean`일 때만(`canReadArtifactContent`). 그 밖에는 상태와 무관하게 404입니다(비멤버에게 검사 전·격리 파일의 존재를 드러내지 않음). 멤버는 메타데이터 API(`GET /projects/:id/artifacts`, `GET /artifacts/:id`)로 상태와 사유를 봅니다.
- 응답 헤더: 판별한 `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition`(이미지는 inline, PDF는 attachment, RFC 5987 `filename*`과 ASCII 대체 이름), `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`.

### 빌드 로그 근거

- 로그 작성·수정에 `evidenceVersionIds[]`(최대 10개, 중복 제거). 같은 프로젝트 버전만 허용하며, 없거나 다른 프로젝트 버전은 같은 422 `not_found`입니다. 검사 대기·검사 중은 붙일 수 있고("검사 중" 표시), 격리·실패는 422 `not_attachable`. 수정 때 생략하면 이전 revision의 근거를 이어받고(이어받은 근거는 상태를 다시 보지 않음), `null`은 비웁니다. `log_revision_evidence`에 revision별로 저장합니다.

### 상태 코드

| 상황 | 응답 |
|---|---|
| 비멤버·없는 프로젝트/산출물/의도, 남의 의도 | 404 |
| reviewer/viewer의 업로드·재검사 | 403 |
| 형식·확장자·파일 크기(의도 단계)·사용자 한도 | 422 `declaredType: unsupported_type` / `fileName: extension_mismatch` / `byteSize: too_large` / `byteSize: quota_exceeded` |
| PUT 본문이 선언 크기를 넘음 | 413 `too_large`(받던 내용 삭제) |
| PUT 본문이 선언 크기보다 작음 | 422 `byteSize: size_mismatch`(삭제) |
| 만료된 의도 | 410 `intent_expired` |
| 이미 받은 의도에 PUT / 받기 전 완료 | 409 `already_uploaded` / `not_uploaded` |
| 업로드 완료(새 버전 / 재완료·같은 내용) | 201 / 200 |

사용자 한도는 그 사용자가 올린 모든 버전의 크기 합(삭제 기능이 생기면 삭제된 버전 제외)과 완료하지 않은 유효한 의도의 선언 크기(예약)를 더해 계산하고, 사용자별 advisory lock으로 직렬화합니다. 한도는 요청 본문이 아니라 계정 상태의 문제이므로 413이 아닌 422로 둡니다.

## 결과

- 의존성은 worker의 `pg-boss`(12.36.0)와 실행기 `tsx`(4.23.15, 이미 lockfile에 있던 버전)만 늘었습니다. 판별·Content-Disposition·clamd 프로토콜은 직접 구현하고 단위 테스트로 고정했습니다.
- 파일 하나를 최대 20MB까지 worker 메모리에 올려 검사합니다(동시 처리 기본 2개).
- pg-boss는 DB에 `pgboss` 스키마를 스스로 만들고 관리합니다(Drizzle migration 대상 아님).
- 알려진 한계(TODO):
  - 이미지 EXIF/GPS 메타데이터를 지우지 않습니다. 공개(T-11) 전에 재인코딩 또는 메타데이터 제거 단계를 추가합니다.
  - 썸네일·PDF 미리보기가 없습니다(§10의 격리된 변환 환경은 별도 작업).
  - S3 호환 driver·서명 URL이 아직 없습니다(배포 전 필수).
  - 만료된 의도와 그 격리 파일, 오래 남은 격리 파일을 지우는 주기 작업이 없습니다.
  - 압축된 PDF 객체 스트림 안의 JavaScript는 자체 점검으로 보지 못하며 clamd의 PDF 휴리스틱에 기댑니다.
  - 링크·저장소 산출물(`kind: link/repo`)은 enum만 두고 만들지 않았습니다. 로그의 근거 링크(T-04)로 대신합니다.
  - 산출물 이름 바꾸기·삭제가 없습니다.

## 대안

- 처음부터 R2 + 서명 URL 직접 업로드: 운영과 같은 경로지만 로컬·CI에 S3 에뮬레이터가 필요하고, 계정이 아직 없습니다. 인터페이스와 API 모양을 맞춰 두고 배포 전에 추가합니다.
- `file-type` 같은 판별 라이브러리: 형식이 넓지만 허용 목록 5종에는 과하고, 업데이트 추적 대상이 늘어납니다.
- ClamAV만 사용: 악성코드는 잡지만 "PNG로 위장한 HTML" 같은 형식 위장은 막지 못합니다. 판별·대조를 먼저 하고 ClamAV를 더합니다.
- 요청 안에서 동기 검사: 20MB 파일과 clamd 지연·장애를 요청이 떠안게 되고 재시도·dead-letter를 둘 수 없습니다.
- DB(bytea)에 파일 저장: 백업이 커지고 스트리밍·서명 URL로 옮기기 어렵습니다.
