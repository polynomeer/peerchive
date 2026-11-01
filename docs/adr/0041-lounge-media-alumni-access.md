# 0041. 공감 라운지 미디어·졸업생 열람: 공식 학교 페이지 자유 게시판 = 라운지 + 글쓴이만 붙이는 이미지(앨범과 같은 격리·검사·EXIF 제거, 글당 4개) + 글을 읽을 수 있는 사람에게만 5분 개인 서명 URL(가린·지운 글 404) + 영상은 미룸 + 졸업생 인증 이력(alumni·인증된 적 있음·active/expired)으로 졸업생·자유 게시판 읽기 전용

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

A-04는 DELIVERY_PLAN §4.3 P2 백로그의 네 번째 졸업생 공간 항목입니다: "이미지·짧은 영상 한도와 메타데이터 제거, 학교 메일이 없어진 졸업생이 인증 이력으로 졸업생 게시판·라운지 열람". 같은 절은 "투입 시간이 부족하면 투표·앨범(A-02 일부)과 라운지 영상(A-04)을 먼저 미루고"라고 영상을 미룰 수 있는 항목으로 둡니다. 관련 설계와 앞선 결정:

- PROOFU_EVOLUTION_PLAN §8.9.9 **공감 라운지** — "공식 학교 페이지의 자유 게시판과 학교를 넘나드는 공감 토픽(§8.9.10)". "익명이 기본이며 이미지·짧은 영상도 올릴 수 있습니다. 업로드는 기존 파일 검사·격리 파이프라인을 그대로 거칩니다." "졸업 후 학교 메일이 없어져도 재학 중 인증 이력으로 졸업생 게시판과 라운지에 계속 들어올 수 있습니다(§8.6)."
- SYSTEM_DESIGN §6.7.2 "공감 라운지 미디어 — 공식 학교 페이지 자유 게시판과 공감 토픽의 이미지·짧은 영상은 `ArtifactVersion` 파이프라인(§10)을 그대로 쓰고, 영상은 길이·용량 한도를 둡니다. 미디어 메타데이터(EXIF 위치 등)는 저장 전에 제거합니다." §8.4 "기관 인증이 만료·철회되면 다음 요청부터 … 기관 페이지·기수 방 접근을 막습니다".
- ADR 0018(C-01): 졸업 뒤 메일이 없어져도 active를 유지하고 주기적 재인증은 없음. 행을 끝낼 때(만료·해제·취소)는 메일 해시를 지우고 학교·인증 시각 이력만 남김. ADR 0019·0021(C-02·C-05): 공식 페이지의 읽기·쓰기는 그 학교 active 인증에서 나오고, 모든 읽기는 `canReadSpace`를 거침. 공식 페이지 기본 게시판은 자유·새내기·졸업생·질문·정보·모집·공지.
- ADR 0022(C-04): 글·댓글, 작성자 id와 글 id를 한 행에 남기는 감사 기록을 두지 않음(익명 작성자를 찾는 길이 됨). 가린 글은 본문을 남기고(이의제기), 지운 글은 비움.
- ADR 0039(A-02): 앨범 사진 = 격리 키 + 두 단계 올리기 + worker `album-photo-scan`(판별·내장 콘텐츠·악성코드 검사 → EXIF·GPS 제거 뒤 같은 키를 바꿔 씀) + 보는 사람에게만 맞는 5분 서명 URL. ADR 0037: P2 플래그 `alumni`, 꺼지면 새 API 404.

## 결정

### 1. 라운지 = 공식 학교 페이지의 자유 게시판

- 새 공간·게시판 종류를 만들지 않습니다. 공식 학교 페이지(`official_school`)의 `free` 게시판이 공감 라운지입니다(`@peerchive/domain isLoungeBoard`). 공식 학과 페이지·사용자 방의 자유 게시판, 졸업생 게시판은 라운지가 아닙니다(미디어 없음). 학교를 넘나드는 공감 토픽(A-05)은 같은 규칙을 그때 붙입니다.
- 이름 표시는 기존 공식 페이지 규칙 그대로(익명 기본, 표시명 선택)입니다. '많이 공감한 글' 탭은 토픽(A-05) 범위로 남깁니다.

### 2. 미디어는 이미지만, 영상은 미룸

- 받는 형식: PNG·JPEG·WebP, 하나 10MB(앨범과 같음, `LOUNGE_MEDIA_TYPES`·`LOUNGE_MEDIA_MAX_BYTES`). **글 하나에 4개**(검사 대기·통과를 셈, 격리·실패는 세지 않음), 올리기 요청은 사용자·시간당 20개.
- **짧은 영상은 이번에 넣지 않습니다**(DELIVERY_PLAN §4.3의 허용). 이유:
  - `@peerchive/files`의 형식 판별(sniff)·메타데이터 제거(strip-metadata)는 이미지(JPEG·PNG·WebP·GIF)와 PDF만 다룹니다. MP4/MOV(ISO BMFF)의 `udta`·`meta`·`©xyz`(위치) 상자를 지우면 `moov` 크기가 바뀌어, `mdat`이 뒤에 있는 파일은 `stco`/`co64` 청크 오프셋을 모두 다시 써야 하고, 조각난 MP4(`moof`)·WebM(EBML) 각각의 구조를 따로 다뤄야 합니다. 의존성 없이 무손실로 하려면 이미지 제거기보다 훨씬 큰 새 파서가 필요하고, 잘못 지우면 "메타데이터를 지웠다"고 표시한 채 위치가 남습니다.
  - 길이 한도도 같은 파서(`mvhd` duration·EBML Duration)가 필요합니다. ffmpeg 같은 무거운 의존성은 이 단계에서 들이지 않습니다.
  - 그래서 영상 형식(`video/*`)은 `declaredType: unsupported_type`(422)이고, 화면은 "영상은 아직 올릴 수 없습니다"를 보여 줍니다. 영상을 넣을 때는 새 ADR로 형식별 파서(또는 격리된 변환 작업)·길이 한도(초기안 30초)·용량 한도를 정합니다.
- 산출물(`artifact_versions`)을 쓰지 않습니다(설계의 "ArtifactVersion 파이프라인"은 같은 **검사·격리 단계**를 쓴다는 뜻으로 읽음). 산출물은 과제(`project_id`)에 묶여 과제 멤버 권한으로 내려가므로, 앨범(ADR 0039)과 같은 이유로 커뮤니티 표를 따로 둡니다.

### 3. 표 `community_post_media` (migration `0037_lounge_media`)

- 열: `post_id`, `uploader_id`(글쓴이와 같음 — 서비스가 확인), `object_key`(`quarantine/<uuid>`, unique), `declared_type`, `file_extension`(png·jpg·jpeg·webp), `byte_size`(1–10MB), `sha256?`, `uploaded_at?`, `scan_status`·`scan_reason`·`scan_engine`·`scan_attempts`·`scanned_at`, `media_type?`, `metadata_stripped`, `created_at`. check: clean이면 `metadata_stripped`·`media_type` 필수. 원래 파일 이름은 저장하지 않습니다(확장자만).
- `space_id`는 두지 않습니다(글이 공간을 가리킴). `uploader_id`는 글의 `author_id`와 같은 값이라 새 연결을 만들지 않고, 탈퇴 정리·"내 것" 판정을 단순하게 합니다.
- **커뮤니티 구역**에 두어 C-05·S-02 경계 검사와 social DB 역할 권한 검사가 자동으로 덮습니다(social 역할 권한 없음). 새 enum이 없습니다.

### 4. 흐름: 앨범과 같은 두 단계 + 같은 검사

1. `POST /community/posts/:id/media {declaredType, fileName, byteSize}` → 201 + 미디어(pending) + `uploadUrl`. **글쓴이 본인**(남의 글 403 `not_author`) + 게시 중인 라운지 글(아니면 409 `post_not_open`, 라운지가 아니면 404) + 쓰기 자격(`canWriteBoard`, active 공간, 이용 제한 없음 — 이미지를 붙이는 것도 쓰기). 한도 409 `media_full`.
2. `PUT …/media/:mediaId/content`(올린 본인만, 15분 안, 넘으면 410 `upload_expired`) → 격리 키에 저장하고 outbox `post-media-scan`.
3. worker(`scanPostMedia`, `@peerchive/files`)가 앨범과 **같은 함수**(`checkAndStripImage` — 이번에 `album-photo-scan.ts`에서 뽑아 두 검사가 함께 씀)로 크기·해시 확인 → 형식 판별·확장자 대조·내장 콘텐츠·악성코드 검사 → **EXIF·GPS·XMP 등 메타데이터를 지운 내용으로 같은 격리 키를 바꿔 쓰고** `clean + metadata_stripped`(해시·크기도 지운 내용으로). 지우지 못하면 failed, 이미지가 아니면 quarantined. clean 키로 옮기지 않으므로 산출물 내려받기 경로로는 나가지 않습니다.
4. 글 응답(`GET /community/posts/:id`)의 `lounge: {items, canAttach, limits}` — 라운지 글이고 플래그가 켜졌을 때만 있습니다. clean 미디어만, 미디어마다 **보는 사람에게만 맞는 5분 서명 URL**(HMAC(affiliation pepper, `post-media:v1:` + 미디어 id + 보는 사람 id + 만료)). 검사 대기·격리·실패는 올린 본인에게만 상태로.
5. `GET …/media/:mediaId/file?exp=&sig=` — 로그인 + 같은 사람 서명 + 만료 전 + **지금 그 글을 읽을 수 있음**(아래 졸업생 열람 포함) + **글이 게시 중** + clean·메타데이터 제거 완료가 모두 맞을 때만 내용. 그 밖은 모두 404. 응답 헤더는 앨범·산출물과 같습니다(nosniff·sandbox CSP·no-store·고정 이름·same-origin, 커뮤니티 경로의 noindex).
6. `DELETE …/media/:mediaId` — 올린 본인만(그 밖 404 — 남의 검사 전 미디어는 보이지 않고, 운영 조치는 글을 가리는 것으로 함). 글이 가려져 있어도 본인은 지울 수 있습니다.

- 응답에 올린 사람 id·원래 파일 이름·저장 키가 없습니다(`mine`만). **감사 기록을 남기지 않습니다**(ADR 0022와 같은 이유: 사람 id + 글 id 한 행). worker 로그에는 미디어 id와 결과 코드만.

### 5. 가린·지운 글

- 가린 글(`hidden`·`auto_hidden`)과 지운 글(`deleted_by_author`)은 미디어를 **누구에게도** 내주지 않습니다(글쓴이 포함, 글 응답의 `lounge.items`는 빈 목록, 파일 404, 새로 붙이기 409).
- 가린 글의 미디어 행·파일은 남깁니다(본문을 남기는 것과 같은 이유 — 이의제기로 되돌리면 다시 보임). 지운 글의 미디어는 worker 정리(`upload-intents` 작업이 함께 부르는 `cleanupPostMedia`)가 다음 회차에 행과 파일을 지웁니다. 끝나지 않은 올리기·검사를 통과하지 못한 미디어는 하루 뒤 지웁니다(앨범과 같음). `orphan-quarantine`은 이 표의 키를 주인 있는 파일로 봅니다.
- 탈퇴 정리(worker purge)는 그 사람이 붙인 미디어 행과 파일을 모두 지웁니다(삭제 장부 `community_post_media`, 파일 수는 `artifact_objects`에서 뺌). 글은 기존대로 "작성자가 삭제한 글"이 됩니다.

### 6. 공개·소셜·검색으로 나가지 않음

- 미디어는 커뮤니티 모듈(`server/modules/community/lounge-media.ts`, 글 응답)만 읽습니다. 공개 DTO·공개 프로필·README 카드·활동 목록(PersonaActivity)·피드·추천·검색 색인은 이 표를 읽지 않고, 소스 경계 테스트(C-05)가 커뮤니티 표 이름 사용을 막습니다. worker 정리 파일(`ops/post-media.ts`)은 경계 검사의 문서화된 예외입니다(키·상태·시각·글 상태만).
- S-02 속성 테스트(`identity-boundary.integration.test.ts`)의 무작위 세계에서 공식 학교 페이지 자유 게시판 글마다 검사를 통과한 미디어를 넣고, 글쓴이 눈의 실제 서명 URL과 미디어 id가 모든 공개·소셜 출력·피드·추천에 0건인지, 미디어 id가 공개 검색 API와 `search_documents`에 없는지 봅니다. 난수를 쓰지 않아 기존 세계는 그대로입니다.

### 7. 졸업생 인증 이력으로 읽기

**무엇을 이력으로 세는가**(`@peerchive/domain countsAsAlumniHistory`, 서버 SQL도 같은 조건):

| 소속 행 | 셈 | 이유 |
|---|---|---|
| `standing = alumni`, `verified_at` 있음, `status = active` | 셈 | 지금도 인증 유지(메일이 살아 있거나 C-01처럼 졸업 뒤에도 active 유지) |
| `standing = alumni`, `verified_at` 있음, `status = expired` | 셈 | **인증된 뒤 메일 확인이 끝난 상태**(메일 해시는 지워지고 학교·인증 시각 이력만 남음) |
| `status = revoked`(본인 해제·운영자 취소·학교 병합 중복·수료증 거절) | 세지 않음 | 이유와 상관없이 본인 또는 운영자가 끊은 인증 |
| `status = pending` / 인증된 적 없는 `expired`(코드 만료·시도 초과·새 요청으로 대체) | 세지 않음 | 인증된 적이 없음 |
| `standing = student`인 이력 | 세지 않음 | 졸업을 선언하지 않은 이력(재학생 이력으로 졸업생 게시판을 여는 것은 설계에 없음) |

- **무엇을 여는가**(`readsByAlumniHistory`·`canReadBoard`): 그 학교(정본 — 병합을 따라감)의 **공식 학교 페이지**의 **졸업생 게시판과 자유 게시판(공감 라운지)** 글·댓글·라운지 미디어 **읽기**와 신고. 공식 학과 페이지·다른 게시판(새내기·질문·정보·모집·공지)·사용자 방은 열지 않습니다.
- **쓰기 규칙은 바꾸지 않습니다**: 글·댓글·공감·미디어 붙이기는 그대로 active 인증(`canWriteBoard`·`canReact`는 `canReadSpace`를 요구)입니다. 이력만 있는 사람의 쓰기 요청은 기존처럼 404(그 공간을 읽을 수 없는 사람과 같은 응답)입니다. 설계(§8.9.9)가 "들어올 수 있다"(열람)만 말하고, 메일 인증이 없는 사람이 익명 라운지에 쓰면 사칭·도배를 막을 근거가 없기 때문입니다.
- 공간 상세 `GET /community/spaces/:slug`는 `access: 'alumni_history'`로 두 게시판만(쓰기 `false`, 권한 모두 `false`), "내 공간" 목록에 그 학교의 공식 학교 페이지가 들어갑니다. 글 응답에는 `alumniHistoryOnly: true`가 붙고 화면이 "졸업생 인증 이력으로 읽는 중, 쓰기는 지금 인증이 필요"를 안내합니다.
- `CommunityViewer.alumniHistorySchoolIds`는 **플래그가 켜졌을 때만** 서버가 채웁니다(`loadViewer`). 다른 모든 판정(`canReadSpace`·`canWriteBoard`·`canModerate`·사용자 방 자격)은 이 값을 보지 않아, 기존 읽기 경로는 바뀌지 않습니다. 이력으로 읽는 경로는 게시판 단위 읽기(`loadBoardReadableSpace`: 게시판 글 목록·글 상세·신고 대상 확인·라운지 미디어)뿐입니다.
- **지금 데이터에서의 의미**: C-01은 졸업 뒤에도 active를 유지하고 인증된 행을 `expired`로 바꾸는 흐름이 아직 없습니다. 그래서 오늘은 대부분의 졸업생이 active로 이미 읽고, 이 규칙은 "인증 뒤 메일 확인이 끝난(expired + verified_at)" 상태가 생길 때 — ADR 0018이 남겨 둔 주기적 재인증이나 운영 정리 — 졸업생이 라운지·졸업생 게시판을 잃지 않게 하는 보장입니다. 그 상태를 만드는 흐름은 이 ADR의 범위가 아닙니다(열린 질문).

### 8. 플래그

- 꺼짐(기본): 미디어 API 4개가 404, 글 응답에 `lounge`·`alumniHistoryOnly`가 없고, 졸업생 인증 이력은 세지 않아 **열람은 active 인증만**(기존 동작 그대로 — 이력만 있는 사람은 공식 페이지·게시판·글 404, 내 공간 목록에 없음). 미디어 행·파일은 남아 다시 켜면 보입니다. 탈퇴 정리·지운 글·끝나지 않은 올리기 정리는 플래그와 무관하게 돕니다.

### 9. 화면

- `/community/p/:id`: 라운지 글에 이미지(검사 통과분), 글쓴이에게 "이미지 붙이기"(형식·크기·개수·"위치 등 사진 정보는 지운 뒤 보입니다"·"영상은 아직 올릴 수 없습니다")와 이미지 지우기, 검사 중·통과하지 못함 상태. 졸업생 인증 이력으로 읽는 사람에게 읽기 전용 안내.
- `/community/s/:slug`: `access = alumni_history`면 안내 문구와 두 게시판만.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| 모든 새 경로 | – | 플래그 꺼짐 404, 401 |
| `POST /community/posts/:id/media` | 201 + `uploadUrl` | 403 `not_author`·`write_restricted`·`write_not_allowed`, 404(라운지 아님·읽을 수 없음), 409 `space_not_active`·`post_not_open`·`media_full`, 422 `declaredType: unsupported_type`(영상 포함)·`fileName: invalid\|extension_mismatch`·`byteSize: invalid\|too_large`, 429 |
| `PUT /community/posts/:id/media/:mediaId/content` | 200 | 404(본인 아님), 409 `already_uploaded`·`post_not_open`, 410 `upload_expired`, 413, 422 `byteSize: size_mismatch` |
| `GET /community/posts/:id/media/:mediaId/file?exp=&sig=` | 200(이미지) | 404(그 밖 모두) |
| `DELETE /community/posts/:id/media/:mediaId` | 200 | 404(본인 아님) |
| `GET /community/spaces/:slug`·`/boards/:id/posts`·`/posts/:id` | 200(이력: `access: 'alumni_history'`·`alumniHistoryOnly`) | 404(이력도 없음, 다른 게시판) |

## 결과

- 라운지 글에 이미지를 붙일 수 있고, 그 이미지는 검사·위치 정보 제거를 거쳐 그 글을 읽을 수 있는 사람에게만, 그 사람에게만 맞는 짧은 URL로 보입니다. 가리거나 지운 글의 이미지는 바로 보이지 않습니다. 공개·소셜·검색으로는 나가지 않습니다(S-02 속성 테스트).
- 인증 뒤 메일 확인이 끝난 졸업생도 그 학교의 졸업생 게시판과 라운지를 계속 읽습니다. 해제·취소·인증 전 이력은 세지 않습니다.
- 한계: **영상은 미뤘습니다**(위 2). 이미지 재인코딩은 하지 않으므로(무손실 메타데이터 제거) 픽셀 안에 든 정보(화면에 찍힌 위치·얼굴)는 남습니다 — 앨범과 같은 한계. 서명 URL은 5분 동안 같은 사람의 다른 탭에서 쓸 수 있습니다(앨범과 같음). 가린 글의 미디어 파일은 이의제기 기간 동안 남습니다. 인증된 행을 `expired`로 바꾸는 흐름이 아직 없어 졸업생 이력 규칙은 지금은 대부분 active 행으로 충족됩니다.

## 대안

- **영상을 지금 받되 메타데이터를 그대로 둠**: 설계("저장 전에 제거")와 맞지 않고, 휴대폰 영상의 위치 상자(`©xyz`)가 그대로 나갑니다.
- **ffmpeg로 다시 인코딩**: 메타데이터·길이 문제를 한 번에 풀지만 무거운 바이너리 의존성·CPU·별도 격리 실행 환경이 필요합니다. 영상을 넣을 때 다시 검토합니다.
- **`artifact_versions` 재사용**: 설계 문구에 더 가깝지만 산출물은 과제 멤버 권한·공개 release 경로와 묶여 있어, 커뮤니티 글 권한으로 내리려면 그 경로 전체에 예외가 생깁니다.
- **이력만 있는 졸업생에게 쓰기도 허용**: 졸업생 참여에는 좋지만 메일 인증 없는 계정이 익명 라운지에 쓰게 되어 사칭·도배 방어가 약해집니다. 설계가 요구하지 않아 열람만 엽니다.
- **revoked `user_removed`도 이력으로 셈**: 본인이 끊은 인증으로 계속 들어오게 하면 "해제"의 뜻이 흐려집니다. 다시 들어오려면 다시 인증합니다.
- **이력으로 공식 페이지 전체 열람**: 재학생 중심 게시판(새내기·질문 등)까지 졸업 뒤에도 보게 되어 설계 범위(졸업생 게시판·라운지)를 넘습니다.
- **미디어를 글 만들기 요청에 함께 받기**: 한 번에 끝나지만 글 쓰기 경로(64KB 본문 상한, 작성 시점 고정 트랜잭션)에 파일 스트림이 섞입니다. 앨범과 같은 두 단계로 두었습니다.
