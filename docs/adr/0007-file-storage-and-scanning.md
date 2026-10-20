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
- 순서: 크기·SHA-256 재확인 → 자체 magic-byte 판별(의존성 없음) → 선언 형식·확장자와 대조(`decideFileType`) → 내장 콘텐츠 점검(이미지 앞부분의 HTML/SVG/스크립트 태그, 파일 끝 ZIP 레코드, PDF의 JavaScript·Launch·EmbeddedFiles·RichMedia·XFA, `#xx` 이스케이프 해제 후) → 악성코드 검사 → 메타데이터 제거(아래 "메타데이터 제거").
- SVG·HTML·XML·ZIP/Office·OLE·실행 파일·스크립트·판별 불가는 격리하고 사유 코드를 남깁니다(`disallowed_type`, `unknown_type`, `type_mismatch`, `extension_mismatch`, `embedded_content`, `pdf_active_content`, `malware`).
- `MalwareScanner` 인터페이스: `clamav`(clamd INSTREAM, TCP, `CLAMAV_HOST`/`CLAMAV_PORT`)와 개발 전용 `signature-only`(형식 판별만, EICAR 시험 문자열만 인식). production에서는 `signature-only`로 worker가 시작되지 않습니다. 로컬 clamd는 `docker compose --profile clamav`로 띄웁니다. `scan_engine`, `scanned_at`, `scan_attempts`를 기록합니다.
- 상태 전이는 순수 함수 `nextScanStatus`로 고정합니다. clean·quarantined는 최종 상태라 중복 실행이 결과를 뒤집지 않습니다. 통과하면 메타데이터를 처리한 내용을 `clean/<versionId>`에 쓴 뒤 DB를 바꾸고 격리 원본을 지우므로, 그 사이에 죽어도 재실행이 같은 결과로 끝납니다. 격리 파일은 격리 키에 그대로 두고 내려주지 않습니다.
- 재시도: 최대 5회, 30초부터 지수 backoff(최대 30분), 작업 만료 5분, 실패 시 `artifact-scan-dead` 큐로(dead-letter). 검사기 오류는 마지막 시도 전까지 `scanning`으로 두고, 마지막 시도에서 `failed`. 내용이 없거나 해시가 다르거나 이미지 메타데이터를 지울 수 없으면(`metadata_strip_failed`) 바로 `failed`. 사용자는 `failed`만 다시 검사 요청할 수 있습니다(`POST /artifacts/:id/versions/:versionId/rescan`).

### 메타데이터 제거

공개 파일럿 전에 추가했습니다(migration `0011_strip_metadata`). 이미지에 남은 촬영 위치(GPS)·기기·작성자·편집 이력이 공개 페이지로 나가지 않게 합니다.

- **위치**: 검사 작업에서 판별·내장 콘텐츠·악성코드 검사를 통과한 뒤, clean 키에 쓰기 전에 합니다(`@peerchive/files`의 `strip-metadata.ts`). 새 의존성(sharp·exiftool) 없이 바이트 단위로 컨테이너 구조를 읽어 메타데이터 단위만 빼는 **무손실** 처리입니다. 다시 인코딩하지 않고, 같은 입력은 언제나 같은 출력이며 출력을 다시 넣어도 같습니다.
- **형식별 처리**

  | 형식 | 지움 | 남김 |
  |---|---|---|
  | JPEG | APP1 Exif(GPS·기기·썸네일 포함)·XMP(확장 XMP 포함), APP13(Photoshop/IPTC), COM, 그 밖의 모든 APPn(JFXX 썸네일·MPF 등), JFIF 안의 썸네일, EOI 뒤에 붙은 내용 | APP0 JFIF, APP2 ICC_PROFILE(색), APP14 Adobe(색 변환), DQT·DHT·SOF·DRI 등, 첫 SOS부터 EOI까지(그대로 복사) |
  | PNG | eXIf, tEXt·zTXt·iTXt, tIME, 그 밖의 부가(소문자로 시작하는) 청크, IEND 뒤의 내용 | IHDR·PLTE·IDAT·IEND, tRNS·cHRM·gAMA·iCCP·sBIT·sRGB·cICP·mDCV·cLLI·pHYs·bKGD·hIST·sPLT, acTL·fcTL·fdAT, 모르는 필수 청크. 남긴 청크는 CRC까지 그대로 |
  | WebP | EXIF·`XMP ` 청크와 모르는 청크(VP8X의 EXIF·XMP 비트도 지우고 RIFF 크기 다시 계산), RIFF 크기 뒤의 내용 | VP8·VP8L·VP8X·ALPH·ANIM·ANMF·ICCP |
  | GIF | 주석 확장, NETSCAPE2.0·ANIMEXTS1.0 외의 애플리케이션 확장(XMP 등), 모르는 확장, 끝 표시 뒤의 내용 | 그래픽 제어·일반 텍스트 확장, 이미지 블록, 색 표, 반복 재생(loop) |

- **JPEG 방향**: 지운 EXIF의 Orientation이 1이 아니면(2–8) Orientation 하나만 든 최소 APP1 Exif(원래와 같은 바이트 순서의 TIFF 헤더, IFD0 항목 1개, 다음 IFD 없음, 36바이트)를 원래 EXIF 자리에 다시 넣어 회전된 사진이 눕지 않게 합니다. 1이거나 없으면 APP1을 넣지 않습니다. EXIF 내부(TIFF)가 깨져 있으면 방향을 모르는 것으로 보고 지웁니다.
- **깨진 파일**: 세그먼트·청크·블록 길이가 파일 밖을 가리키거나(잘림), 구조가 틀리거나(마커·IHDR·RIFF 헤더·CRC 오류) 지원하지 않으면 `MetadataStripError`를 던지고, 검사 작업은 버전을 `failed`(`metadata_strip_failed`, 재시도 없음)로 둡니다. 지우지 못한 원본은 어떤 경로로도 내려주지 않습니다.
- **PDF**: 고쳐 쓰지 않습니다(무손실 제거가 어렵고 서명·양식이 깨질 수 있음). Info 사전의 `/Author`·`/Creator`·`/Producer`(리터럴·hex·UTF-16·간접 참조)와 압축되지 않은 XMP의 `dc:creator`를 찾아 **속성 이름 + 가린 표본**(앞 1글자, 예: `홍**`)만 저장합니다. 값 전체는 어디에도 저장하지 않습니다. 압축된 객체 스트림 안의 속성은 보지 못합니다(best-effort).
- **저장**: 내려줄 바이트(이미지는 제거본, PDF는 원본)를 `writeObject`(새 격리 키에 쓴 뒤 `move`로 원자적 교체)로 `clean/<versionId>`에 쓰고, DB를 clean으로 바꾼 **뒤** 격리 원본을 지웁니다. clean 키에 쓴 뒤 DB 갱신 전에 죽으면 격리 원본이 남아 있으므로 재실행이 같은 결과를 다시 씁니다. DB 갱신 뒤 원본을 지우기 전에 죽으면 원본이 격리 키에 남습니다(내려주지 않음, 오래된 격리 파일 정리 작업 대상). `move`는 대상이 있으면 덮어씁니다.
- **기록**(`artifact_versions`): `metadata_stripped`(이미지 제거본을 내려주는지, PDF는 false), `stripped_sha256`·`stripped_bytes`(내려주는 내용의 해시·크기), `metadata_findings`(jsonb, `@peerchive/domain`의 `MetadataFindings`: 이미지는 지운 종류와 다시 쓴 방향, PDF는 속성 이름 + 가린 표본). 원래 `sha256`·`bytes`는 그대로 둡니다. 같은 내용 중복 판단(업로드 완료)과 사용자 저장 한도는 사용자가 올린 원본 기준이기 때문입니다.
- **내려주기**: 비공개·공개 내용 경로 모두 clean 키의 제거본을 내려주고, `Content-Length`는 `stripped_bytes`, ETag는 `stripped_sha256`으로 만듭니다(비공개 `"v-<해시 16자>"`, 공개 `"pe<epoch>-r<버전>-<해시 16자>"`). 새 공개 스냅샷의 파일 크기도 제거본 크기입니다.
- **이전 버전(backfill)**: 이 변경 전에 clean이 된 이미지는 `metadata_stripped = false`입니다. 안전한 기본값으로 이런 이미지는 새 공개 후보에서 422 `metadata_not_stripped`(파일·마일스톤 스냅샷), 공개 파일 조회에서 404이고, 이미 만든 후보의 ready 판정에서는 "검사 대기"(`file_not_clean`, `pending`)로 봐 게시되지 않습니다. 올린 팀의 비공개 작업 공간에서는 그대로 보입니다. 일회성 명령 `pnpm --filter worker backfill-strip [--dry-run] [--batch=100]`이 clean 키에서 읽어 메타데이터를 지우고(같은 방식으로 원자적 교체) 표시하며, clean PDF의 문서 속성 점검 결과도 채웁니다. 멱등이고(처리한 행은 다시 고르지 않음, 내용만 바뀌고 기록 전에 죽었다면 다음 실행이 그대로 기록), 원본도 제거본도 아닌 내용(해시 불일치)·깨진 이미지는 바꾸지 않고 실패로 보고합니다(종료 코드 1).
- **공개 전 점검·화면**: 공개될 PDF에 작성자 속성(Author·dc:creator)이 있으면 경고 `pdf_metadata`("PDF 문서 속성에 작성자 정보가 있습니다 — 공개 전에 문서 속성을 지우고 다시 올리세요", 표본 예: `Author: 홍**`). Creator·Producer는 대개 프로그램 이름이라 기록만 하고 경고하지 않습니다. 과제 화면의 산출물 섹션은 지운 이미지에 "메타데이터 제거됨", 작성자 속성이 있는 PDF에 "PDF 문서 속성에 작성자 정보 있음"을 글자로 보여 줍니다.

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

- 의존성은 worker의 `pg-boss`(12.36.0)와 실행기 `tsx`(4.23.15, 이미 lockfile에 있던 버전)만 늘었습니다. 판별·Content-Disposition·clamd 프로토콜·메타데이터 제거는 직접 구현하고 단위 테스트로 고정했습니다.
- 파일 하나를 최대 20MB까지 worker 메모리에 올려 검사합니다(동시 처리 기본 2개).
- pg-boss는 DB에 `pgboss` 스키마를 스스로 만들고 관리합니다(Drizzle migration 대상 아님).
- 알려진 한계(TODO):
  - 메타데이터 제거(위 절)의 한계: PDF는 고쳐 쓰지 않고 경고만 합니다(압축된 객체 스트림 안의 속성은 못 봄). JPEG의 첫 SOS 뒤(스캔 사이)의 세그먼트는 그대로 둡니다. HEIC·AVIF·TIFF 등은 허용 형식이 아니라 다루지 않습니다. 픽셀 자체에 든 정보(화면에 찍힌 이름·위치 등)는 지우지 못합니다.
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
