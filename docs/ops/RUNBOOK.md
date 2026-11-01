# Peerchive 운영 runbook (파일럿)

제한된 파일럿(학생 50명·과제 20개 수준, SYSTEM_DESIGN §14)을 한 사람이 운영한다는 전제의 절차서입니다. 결정 배경은 [ADR 0016](../adr/0016-deletion-ledger-maintenance-analytics.md)(탈퇴 정리·삭제 장부·점검 모드·분석), [ADR 0018](../adr/0018-school-affiliation.md)(학교 메일 인증), [ADR 0019](../adr/0019-community-spaces.md)(커뮤니티 공간·공식 페이지), [ADR 0017](../adr/0017-smtp-mail-and-s3-storage.md)(SMTP 메일·S3 호환 저장소), [ADR 0012](../adr/0012-publish-withdraw-public-read.md)(공개 읽기 운영 스위치), [ADR 0015](../adr/0015-reports-moderation-appeals.md)(신고·조치), [ADR 0027](../adr/0027-community-ops-metrics.md)(처리 기한·운영 시간·커뮤니티 지표)를 보세요. 값·명령은 [apps/README.md](../../apps/README.md)의 환경 변수 표와 같습니다.

목표 값은 SLA가 아니라 검증할 설계 목표입니다. 호스팅 공급자·가격은 정하지 않았습니다(DELIVERY_PLAN §10). `<…>` 자리는 파일럿 전에 채웁니다.

## 1. 배포 전 점검표

| 항목 | 확인 | 상태 |
|---|---|---|
| `NODE_ENV` | 지정하지 않거나 `production`(빌드 결과·worker는 기본 production). `development`로 두지 않음 | 운영자 확인 |
| `DATABASE_URL` | 서비스 전용 계정, TLS 접속, 비밀 저장소에서 주입. 0008 migration의 `pg_trgm` 확장 허용 | 운영자 확인 |
| `pnpm db:migrate` | 배포마다 web·worker보다 먼저 | 절차 |
| social DB 역할(S-02) | `peerchive_social`(NOLOGIN, 커뮤니티 테이블 권한 없음)이 있고 권한이 적용됨. migration 계정에 CREATEROLE이 없으면 0027 migration은 역할을 만들지 않고 넘어가므로 DB 관리자가 한 번 `CREATE ROLE peerchive_social NOLOGIN;` 실행 뒤 테이블 주인 계정으로 `SELECT peerchive_apply_social_grants();`(true여야 함). 확인 SQL은 아래 §2 GP([ADR 0029](../adr/0029-identity-boundary.md)). 0028 migration이 같은 함수에 과제 수행 목록 읽기 권한(두 표 + 과제·학기·과목·엠바고·학교 인증의 필요한 열만)을 더했으므로 역할을 나중에 만들었다면 함수를 다시 부르면 됩니다([ADR 0031](../adr/0031-visibility-settings.md)). 0029 migration은 팔로우·차단·뮤트 세 표의 SELECT를 더했습니다([ADR 0033](../adr/0033-follows-blocks.md)). 0031 migration은 프로필 글 SELECT와 활동 카드 함수 `persona_activity_cards` 실행 권한을 더했습니다. **S-05부터 앱이 활동 목록·피드·추천을 이 역할로 읽습니다**(트랜잭션마다 `SET LOCAL ROLE peerchive_social`, [ADR 0035](../adr/0035-profile-feed.md)): 앱 DB 계정이 역할의 멤버여야 합니다 — `GRANT peerchive_social TO <앱 계정>;`(확인: `select pg_has_role('<앱 계정>', 'peerchive_social', 'MEMBER')`가 true). 빠지면 그 세 API가 500으로 실패합니다(fail closed, production은 `PEERCHIVE_SOCIAL_DB_ROLE=off`를 받지 않음) | 절차 |
| `NUXT_SITE_ORIGIN` | 실제 https origin(쉼표로 여러 개). 로그인 링크·CSRF 기준. **worker에도 같은 값**(소셜 링크 되돌림 확인이 찾을 `/u/<handle>` 주소의 origin, S-06 — 없으면 worker가 경고를 남기고 확인·재확인을 건너뜀) | 운영자 확인 |
| 메일 | `PEERCHIVE_MAIL_TRANSPORT=smtp`, `PEERCHIVE_SMTP_URL`(`smtps://…:465` 또는 `smtp://…:587` STARTTLS 필수, 비밀 저장소), `PEERCHIVE_MAIL_FROM`(발송 도메인의 주소). TLS 없는 SMTP·dev-console·설정 누락이면 web이 시작하지 않음. 공급자 쪽: 발송 도메인 SPF·DKIM·DMARC DNS, 발송 한도, 반송 처리(아래 §1.1) | **구현됨 — 공급자 설정 필요** |
| 파일 저장소 | `PEERCHIVE_STORAGE_DRIVER=s3` + `PEERCHIVE_S3_ENDPOINT`(https)·`_REGION`·`_BUCKET`·`_ACCESS_KEY_ID`·`_SECRET_ACCESS_KEY`(·`_FORCE_PATH_STYLE`·`_PREFIX`), web·worker 같은 값. 설정이 빠졌거나 http endpoint면 web·worker가 시작하지 않음. 공급자 쪽: 비공개 버킷·버전 관리·전용 키(아래 §1.1). 단일 서버 파일럿만 `PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION=1` + 백업 대상 디스크 | **구현됨 — 공급자 설정 필요** |
| 악성코드 검사 | `PEERCHIVE_MALWARE_SCANNER=clamav` + `CLAMAV_HOST/PORT`(signature-only는 production에서 worker가 거부). clamd 서명 갱신 확인 | 운영자 확인 |
| 디스코드 | `PEERCHIVE_INTERNAL_SECRET`(32자 이상 무작위, web·bot 같은 값), `DISCORD_BOT_TOKEN`, 슬래시 명령 등록. 실제 디스코드 연동은 미검증 | 미검증 |
| pepper | `PEERCHIVE_ANALYTICS_PEPPER`, `PEERCHIVE_DELETION_PEPPER`, `PEERCHIVE_AFFILIATION_PEPPER`(web만), `PEERCHIVE_MEMBER_REF_PEPPER`(web만, 익명 스터디 기록의 멤버 가명 키 — [ADR 0026](../adr/0026-study-records.md) 부록) 각각 `openssl rand -hex 32`, 서로 다름. **삭제·학교 인증 pepper는 바꾸지 않음**(재적용이 장부를, 한 주소 한 계정 확인이 이전 인증을 못 맞춤). 멤버 가명 키 pepper는 저장하지 않는 키라 바꿀 수 있음(바꾸면 열려 있던 기록 화면은 새로 고침해야 하고 그 사이 입력은 422). 없으면 분석은 꺼지고 worker는 시작하지 않으며, 학교 인증·멤버 가명 키 pepper가 없거나 약하면 web이 시작하지 않음 | 운영자 확인 |
| 학교 메일 인증(C-01) | `PEERCHIVE_HUB_REQUIRE_AFFILIATION`은 비우거나 `1`(production에서 `0`이면 web이 시작하지 않음). **파일럿 학교마다 메일 도메인 등록**(아래 §4.1) — 등록 전에는 그 학교 학생이 인증할 수 없어 선배 노트를 쓸 수 없음 | 절차 |
| 탈퇴 유예 | `PEERCHIVE_DELETION_GRACE_DAYS`(기본 7). web·worker 같은 값 | 기본값 |
| 공개 색인 | `PEERCHIVE_PUBLIC_INDEXING`은 파일럿 동안 끔(noindex) | 기본값 |
| 프록시 | 프록시·로드밸런서 뒤라면 `PEERCHIVE_TRUSTED_PROXIES`에 프록시 CIDR을 설정(설정하지 않으면 X-Forwarded-For를 무시하고 소켓 주소만 사용). 잘못된 CIDR이 있으면 production에서 서버가 뜨지 않음 | 구현됨 — 배포 환경 CIDR 설정 필요 |
| worker egress(S-06) | worker의 링크 수집기만 사용자가 붙인 URL에 접속합니다(웹은 접속하지 않음). 수집기가 https·443만, DNS 결과 전부를 검사(사설·loopback·link-local·CGNAT·메타데이터 169.254.169.254·IPv4-mapped·ULA 거부)하고 그 주소로 고정해 접속하지만, **네트워크에서도 한 겹 더**: worker의 바깥 접속은 443(과 DB·저장소·clamd·SMTP 등 필요한 곳)만 열고, 클라우드 메타데이터 주소와 내부망 대역으로의 egress를 막습니다. 프록시를 거쳐야 하는 환경이면 수집기는 프록시를 쓰지 않으므로(`HTTPS_PROXY` 무시) 직접 443 egress가 필요합니다 | 운영자 확인 |
| 운영자 | `pnpm --filter @peerchive/db grant-operator <email>`로 최소 두 사람 | 운영자 확인 |
| 백업 | 아래 §5 일정이 실제로 돌고 복구 연습이 통과 | 절차 |
| worker 상태 | `/operator/metrics`의 시스템 상태가 정상(worker 기록 3분 이내, dead-letter 없음) | 절차 |

### 1.1 공급자 쪽 설정(코드 밖, ADR 0017)

메일·저장소 공급자는 정하지 않았습니다. 고른 뒤 아래를 공급자 화면·DNS에서 직접 합니다.

**메일(SMTP)**
- [ ] 발송 도메인(`PEERCHIVE_MAIL_FROM`의 도메인)을 공급자에서 인증. 사이트와 다른 하위 도메인(예 `mail.<도메인>`) 권장.
- [ ] DNS: SPF(`v=spf1 include:<공급자> -all` 등 공급자 안내값), DKIM(공급자가 준 selector 레코드), DMARC(`_dmarc` TXT, 처음엔 `p=none; rua=mailto:<보고 주소>`로 시작해 정상 확인 뒤 `quarantine`/`reject`).
- [ ] SMTP 전용 자격 증명(이 용도만, 최소 권한)을 비밀 저장소에 두고 `PEERCHIVE_SMTP_URL`로 주입. 465(암묵적 TLS) 또는 587(STARTTLS)만.
- [ ] 발송 한도·반송(bounce)·스팸 신고 알림을 운영자 주소로. 반송된 주소 자동 처리는 아직 없음(수동 확인).
- [ ] 실제 주소 두 곳(학교 메일·개인 메일)으로 로그인 메일 수신과 스팸함 여부 확인. 링크가 `/auth/verify#token=`인지 확인.

**저장소(S3 호환)**
- [ ] 버킷은 **비공개**(공개 읽기·정적 웹 호스팅·공개 URL 끔, R2는 공개 `r2.dev`·사용자 도메인 연결 안 함). CORS 설정 불필요(브라우저가 직접 접근하지 않음, 모든 내용은 서버가 권한 확인 뒤 스트림).
- [ ] 이 버킷만 읽기·쓰기·지우기·목록 할 수 있는 전용 키(관리자 키 금지).
- [ ] 버전 관리(versioning) 켜기 + 이전 버전 보존 기간(예 30일, 백업 보존과 맞춤)의 수명 주기 규칙. 가능하면 다른 지역·계정으로 복제. 삭제 요청 처리상 이전 버전도 보존 기간 뒤 사라지게 둡니다(ADR 0016 "백업 안의 자료").
- [ ] 저장 시 암호화(공급자 기본) 확인. 미완성 multipart 정리 규칙은 선택(이 driver는 multipart를 쓰지 않음).
- [ ] 배포 뒤 운영자로 `GET /api/v1/health?deep=1`의 `storage.status=ok`, `driver=s3` 확인.

## 2. 게이트 점검(DELIVERY_PLAN §7)

### G1: private alpha(내부 팀 2개)

| 필수 확인 | 구현된 것 | 남은 것 |
|---|---|---|
| 권한 | 프로젝트 역할 정책·비공개 404·운영자도 비공개 과제 404(T-03·T-10·T-15), 통합 테스트, 브라우저 E2E(다른 사용자·익명 404, owner의 남의 선언 수정 403, [apps/e2e](../../apps/e2e/README.md)) | E2E를 CI 필수 검사로 전환(지금은 선택 작업) |
| 저장 | 로그 revision·version 409·clientId 재전송(T-04~T-08), 백업·복구 스크립트(T-16) | 운영 DB의 정기 백업 일정 등록 |
| 파일 격리 | 3단계 업로드·worker 검사·clean만 제공·메타데이터 제거(T-05), 만료 의도·주인 없는 격리 파일 정리(T-16), S3 호환 driver(D-02, ADR 0017) | ClamAV 운영 확인, 저장소 공급자 선택·비공개 버킷·버전 관리(§1.1) |
| 계정 상태 | 정지·탈퇴 세션 거부(T-02), 탈퇴 정리·장부(T-16), SMTP 로그인 메일(D-01, ADR 0017) | 탈퇴 취소 화면(유예 중 운영자 수동), 메일 공급자 선택·SPF/DKIM/DMARC(§1.1) |
| 봇 수집 | `/log`·📌·서명 내부 API·재전송 중복 방지(T-09) | 실제 디스코드 서버에서 확인 |
| 내부 팀 2개 사용 | — | 모집·운영 |

### G2: 제한 public

| 필수 확인 | 구현된 것 | 남은 것 |
|---|---|---|
| 공개 동의 | manifest 해시 동의·미동의자 제외(T-11) | — |
| 엠바고 | 단조 엠바고·게시 거부(T-10) | 학교별 실제 학기 일정 확인 |
| 철회 | 즉시 차단·access_epoch·파생 정리(T-12~T-14), 탈퇴 때 지금 release 철회(T-16) | — |
| 파생 차단 | 검색·신호·케이스·포트폴리오 읽기 시 상태 확인(T-13·T-14) | — |
| 신고 | 신고·보류·조치·이의제기·감사(T-15) | 담당자·대응 시간 채우기(§7) |
| 복구 | `ops/backup.sh`·`ops/restore.sh`·`ops/restore-drill.sh`·재적용·점검 모드(T-16), 연습 결과 §6 | 운영 환경에서 같은 연습 |
| 삭제 절차 | 탈퇴 요청 → 유예 7일 → 정리 + 장부(T-16), 이 문서 §4 | 법무·학교 규정 검토(완료로 치지 않음) |
| 신고 담당자·대응 시간 | 자리(apps/README.md "운영", §7) | 사람·연락 채널 지정 |

### GC: 커뮤니티 개방

커뮤니티는 이 표가 모두 채워지기 전에는 실제 사용자에게 열지 않습니다(DELIVERY_PLAN §7, apps/README 결정 기록). C-04·C-05·C-06 행(코드 쪽 필수 조건)은 구현됨, 사람·절차 행(담당·모더레이터·법률 검토·이용 규칙)은 아직입니다.

| 필수 확인 | 구현된 것 | 남은 것 |
|---|---|---|
| G3 통과 | — | G3 게이트 |
| C-05 열람 범위(비로그인·다른 학교·미인증·비멤버·내보냄·나감·인증 해제 404) | 정책 함수 `canReadSpace`·`canPreviewSpace` 한 곳, 인증 해제 다음 요청부터 404(학교 무관 방도 인증 하나 필요), 행위자 × 경로 매트릭스 통합 테스트·E2E(`community-visibility`)([ADR 0021](../adr/0021-community-visibility.md)) | 개방 직전 운영 DB에서 §4.2 "확인"을 다른 학교·미인증 계정으로 다시 실행 |
| C-05 소개(preview) 최소화 | listed 방만 소개 글, unlisted 방은 이름·멤버 수·가입 방식만, 초대 전용 방은 소개 없음(승인 대기 중이어도), 초대 링크도 학교 자격이 없으면 이름 없이 404 | — |
| C-05 검색엔진 비노출 | `/robots.txt`(색인 꺼짐이면 전부 막음, 켜도 `/community`·`/api/v1/community`·개인 화면 차단), 모든 커뮤니티 응답 `X-Robots-Tag: noindex, nofollow, noarchive`·`no-store`·`no-referrer`, robots meta, 사이트맵 없음(생기면 커뮤니티 제외를 테스트가 강제) | 배포 도메인에서 `curl -s https://<도메인>/robots.txt` 확인, 검색엔진 콘솔에서 `/community` 색인 0건 확인(개방 뒤 주 1회) |
| C-05 링크 미리보기 | 비로그인·봇(Slackbot·Discordbot·facebookexternalhit·Twitterbot 등)은 어떤 방 주소에도 같은 404 고정 HTML(이름·payload·OG 없음), 멤버 화면도 제목 고정 `Peerchive 커뮤니티`·og·description 없음 | 배포 도메인에서 아래 curl로 확인 |
| C-05 데이터 경계(공개 검색·임베딩·집계에 커뮤니티 본문 0건) | schema.ts 커뮤니티 구역의 테이블(C-04의 `community_posts`·`community_comments`·`thread_aliases`·`community_reactions` 자동 포함)을 커뮤니티 모듈과 문서화된 예외만 읽는 소스 검사, 센티넬 공간·글·댓글이 커뮤니티 밖 모든 테이블·공개 조회에 0건, 감사·분석은 id·코드만(글 쓰기에는 감사 없음, 익명 글 분석은 사용자 키 없음), 로그아웃 시 화면 데이터 버림 | — |
| C-04 작성자 비노출(익명 스레드 번호·방장/모더레이터 동일 응답) | 작성 시점 `name_mode` 고정(공간 행 FOR SHARE + `nameModeAtWrite`, DB 트리거가 UPDATE 거부), 스레드마다 `글쓴이`·`익명N`(스레드 사이 비연결), 응답·운영자 신고 상세에 사람 id·이메일·핸들 없음(통합 테스트·E2E `community-posts`), 신고 → `hide_post`·`hide_comment`(가리기, 삭제 아님)([ADR 0022](../adr/0022-community-posts.md)) | 개방 직전 운영 DB에서 `select tgname from pg_trigger where tgname like '%frozen%' or tgname = 'thread_aliases_immutable'`로 트리거 3개 확인 |
| C-06 신고 누적 임시 숨김 | 서로 다른 인증 신고자(작성자·인증 해제·다른 학교 제외) 공식 5·방 3에서 같은 트랜잭션으로 `auto_hidden`("운영 검토 중"), 신고자·대상마다 한 번, 대기열 맨 앞 우선 검토, 기각 = 복원·가리기 = 확정, 작성자 알림(신고자·수 없음)(통합 테스트·E2E `community-moderation`, [ADR 0023](../adr/0023-community-moderation.md)) | 파일럿 학교 규모를 보고 기준 수 확인(`PEERCHIVE_COMMUNITY_AUTO_HIDE_OFFICIAL`·`_ROOM`, 기본 5·3) |
| C-06 작성자 비노출(방 운영진·제재 경로) | 방 운영진 가리기·제재 요청·공간 운영 화면·당사자 안내·운영자 신고 상세·확인 기록·제재 목록·감사·분석 어디에도 익명 작성자 없음(표면 12곳 통합 테스트), 작성자 확인은 운영자만·사유 필수·기록 + 감사(id만)·시간당 20 | 개방 직전 운영 DB에서 `select action, metadata from audit_events where action like 'community.%' order by at desc limit 50`로 metadata가 id·코드뿐인지 확인 |
| C-06 단계별 이용 제한 | 경고·쓰기 기간 제한(1~365일)·커뮤니티 영구, 커뮤니티 전체 또는 그 공간, 같은 운영자의 24시간 안 확인으로만 발급, 커뮤니티 쓰기만 403 `write_restricted`(과제 공간·포트폴리오·공개 프로필·과목 허브 무관 — 통합 테스트), 기한 뒤 자동 해제, 제재마다 이의제기 한 번 | 이용 규칙 공지에 단계·이의제기 경로를 적기(아래 행) |
| 신고 검토 담당·주간 시간·대응 시간 | 처리 기한 배지·기한 넘김 필터(`/operator`, 기본 임시 숨김 24시간·그 밖 72시간), 주간 운영 시간 기록(`/operator/ops-time`), 지표의 처리 시간·운영 시간 합계(C-10, [ADR 0027](../adr/0027-community-ops-metrics.md)). 측정 방법은 아래 "GC 측정 점검" | 사람 지정(§7), 개방 전 2주 동안 §4.4 주간 루틴을 실제로 돌려 기록이 쌓이는지 확인 |
| pilot 학교 모더레이터 2명 이상 | 지정 API(§4.2) | 사람 지정 |
| 게시 중단 요청 절차 법률 검토·이용 규칙 공지 | — | 검토·공지 |

#### GC 측정 점검(C-10)

GC 표의 각 행이 "구현됨"인지와 별개로, 개방 직전과 개방 뒤 매주 아래 값이 **측정되는지**(그리고 목표 안인지) 확인합니다. 화면·API는 운영자 계정으로, SQL은 운영 DB 읽기 전용 계정으로 실행합니다. 지표 값은 모두 5 미만이면 가려집니다(null) — "가림"은 실패가 아니라 표본이 작다는 뜻입니다.

| 확인할 것 | 어디서 | 기준(초안) |
|---|---|---|
| 신고 대기열이 밀리지 않음 | `GET /api/v1/health?deep=1`의 `reports.open`·`reports.overdue`·`reports.overdueAutoHidden`·`reports.oldestOpenAgeSeconds`(상태 화면 `/operator/metrics` "처리 전 신고 묶음") | `overdueAutoHidden = 0`. 0이 아니면 아래 에스컬레이션 |
| 자동 숨김 → 검토 완료 중앙값 | `/operator/community-metrics` "신고·처리 시간" 또는 `GET /api/v1/operator/metrics/community?from=&to=`의 `moderation.medianAutoHiddenResolutionHours` | 24시간 이내(DELIVERY_PLAN §6.1). 넘으면 §9.1 대응 |
| 기한 안 처리 비율·첫 조치까지 시간 | 같은 응답 `moderation.slaMet`·`medianFirstActionHours` | 관찰(목표는 운영 회의에서) |
| 주간 신고 검토 시간 | 같은 응답 `opsTime.weeks[].minutes.reports`·`total`(운영자 각자 `/operator/ops-time` 기록) | 제품 기획 §19 질문 10의 가용 시간 이내. 기록이 비어 있으면 측정 실패로 봄 |
| 작성자 확인이 모두 신고·요청과 이어짐 | `moderation.authorLookupsLinked`(값이 가려지면 아래 SQL) | 100% |
| 자동 숨김·복원 | `moderation.autoHideRate`·`restoreRate` | 복원률이 높으면(예: 절반 이상) 임시 숨김 기준 수(`PEERCHIVE_COMMUNITY_AUTO_HIDE_*`) 재검토 |
| 커뮤니티 → 아카이브 전환(핵심) | `conversion.questionToStuck`·`conversion.studyRecordConversion` | §6.1 판단 초안(질문의 10% 또는 20건, 스터디 30%) — 학기 단위로 판단 |
| 익명 이벤트에 사용자 키 없음 | SQL ① | 0행 |

```sql
-- ① 사용자 키가 붙으면 안 되는 이벤트에 키가 있는지(0이어야 함)
select name, count(*) from analytics_events
where actor_hash is not null
  and (name::text in ('community_report_filed','community_auto_hidden','community_sanction_issued','community_author_lookup','archive_transfer_requested','archive_transfer_completed','course_qa_published')
       or (name::text in ('post_created','comment_created') and props->>'mode' = 'anonymous'))
group by name;
-- ② 지금 처리 전 신고 묶음과 가장 오래된 것(시간)
select count(distinct target_key) as open_groups, round(extract(epoch from now() - min(created_at)) / 3600) as oldest_hours
from reports where status in ('open','in_review');
-- ③ 기한을 넘긴 임시 숨김 묶음 수(기본 24시간)
select count(*) from (select target_key, min(auto_hidden_at) as hidden from reports
  where status in ('open','in_review') and auto_hidden_at is not null group by target_key) g
where g.hidden < now() - interval '24 hours';
-- ④ 신고·요청과 이어지지 않은 작성자 확인(최근 30일, 0이어야 함)
select count(*) from community_author_lookups where report_id is null and request_id is null and created_at > now() - interval '30 days';
-- ⑤ 최근 4주 운영 시간 합계(주·분야별, 사람별 아님)
select week, sum(reports_minutes) reports, sum(official_pages_minutes) official_pages, sum(affiliation_support_minutes) affiliation,
       sum(curation_minutes) curation, sum(other_minutes) other
from ops_time_entries group by week order by week desc limit 4;
```

링크 미리보기 확인(배포 도메인, 방 주소는 시험 방):

```sh
for ua in 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' 'facebookexternalhit/1.1' 'Twitterbot/1.0'; do
  curl -s -o /tmp/unfurl.html -w '%{http_code} ' -A "$ua" https://<도메인>/community/s/<slug>; md5 -q /tmp/unfurl.html 2>/dev/null || md5sum /tmp/unfurl.html
done   # 모두 404, 같은 해시, 본문에 방 이름 없음
curl -sI https://<도메인>/community/s/<slug> | grep -i 'x-robots-tag'   # noindex, nofollow, noarchive
```

### GP: 공개 프로필·팔로우 개방

공개 프로필·팔로우·피드는 이 표가 채워지기 전에는 열지 않습니다(DELIVERY_PLAN §7 GP). S-01~S-07의 코드 쪽 조건은 모두 구현되었습니다. 남은 것은 아래 "개방 직전 확인" 열의 운영 쪽 확인(G2 통과, 표시명 사칭 처리 기준 공지, 운영 DB SQL)입니다.

| 조건 | 구현·근거 | 개방 직전 확인 |
|---|---|---|
| S-01 표시명 ↔ 실명 연결 | 연결이 꺼져 있으면 두 공개 프로필의 JSON·HTML·OG·인쇄 보기·README 카드에 상대 정보 0건(통합 테스트·E2E `r-personas`, [ADR 0028](../adr/0028-personas.md)) | — |
| S-02 정체성 누출 0건 | 모듈 의존 테스트(social·프로필 라우트·공개 프로필 경로에서 import로 닿는 파일에 커뮤니티 모듈·테이블 없음), social DB 역할(커뮤니티 테이블 권한 0), `persona_activities.persona_id NOT NULL` + 투영 트리거(익명 글 거부), 작성 시점 페르소나, 시드 고정 속성 기반 회귀 테스트(`identity-boundary.integration.test.ts`, [ADR 0029](../adr/0029-identity-boundary.md)) | 운영 DB에서 아래 SQL ①~③. 개방 전 한 번 `S02_PROPERTY_WORLDS=50`으로 회귀 테스트를 돌려 통과 확인 |
| S-06 소셜 링크 | 페르소나별 링크·같은 주소 두 프로필 불가, 수집은 worker의 SSRF 방어 수집기만(수집기·주소 판정·시나리오 V worker 테스트, [ADR 0034](../adr/0034-social-links.md)), 배지 문구 "인물·경력을 검증하지 않습니다" | 파일럿 사용자 몇 명에게 `링크 확인됨`이 인물 검증으로 읽히지 않는지 확인. worker egress(§1)와 `NUXT_SITE_ORIGIN`(worker) 확인 |
| S-03 공개 범위 | 계정 전체를 `전체 공개`로 바꿔도 동의 전 공개 후보·비공개 과제 공간·엠바고 중 제목 0건, 과제 수행 목록은 과목·학기·제목만(`visibility.integration.test.ts`·E2E `s-visibility`, [ADR 0031](../adr/0031-visibility-settings.md)) | — |
| S-04 차단 404 | 차단당한 사용자는 숨긴 페르소나의 세션 경로·팔로우 목록에서 404, 차단·팔로워 삭제·뮤트에 알림 0건(`follows.integration.test.ts`·E2E `t-follows`, [ADR 0033](../adr/0033-follows-blocks.md)) | 로그아웃 공개 화면은 차단을 판별하지 못함(ADR 0033)을 공지 문구에 반영 |
| S-05 프로필 글·피드·추천 | 활동 목록·피드·추천은 `persona_activities`만 원천으로 읽고(social DB 역할 트랜잭션), 항목마다 원본 상태·공개 범위·차단·뮤트를 다시 확인(`persona_activity_cards`). 거두기는 원본 상태가 바뀌는 같은 트랜잭션의 DB 트리거, 투영은 outbox → worker. 인기·팔로워 수 정렬 없음, 추천은 과목·학교(배지 공개 실명만)·관심 직무 교집합(`feed.integration.test.ts`·S-02 속성 테스트의 피드·활동·추천 확장·E2E `s05-feed`, [ADR 0035](../adr/0035-profile-feed.md)). 알림·프로필 글 사진은 후속 | 앱 계정이 `peerchive_social` 멤버인지(§1), 아래 SQL ④(거둔 원본인데 남은 활동 0행), worker의 `persona_activity.project` 큐가 밀리지 않는지(`GET /api/v1/health?deep=1`의 outbox 대기) |
| S-07 신고 대상·표시명 사칭·계측 | 신고 대상에 페르소나(실명·표시명)·프로필 글·소셜 링크. 신고·조치·운영 화면은 **그 페르소나 하나만** 가리키고(주인 사용자 id 없음), 숨김은 그 페르소나·글·링크만(같은 사람의 다른 프로필은 그대로), 이의제기로 복원. 표시명 사칭 사유는 프로필 신고에만, 처리 기준은 §4.5. 페르소나 주인 확인은 사유 기록 + 감사(id만)로만, 감사 조회는 주인의 자기 행동 행에서 행위자를 비움. §6.2 이벤트 11개(사용자 키·시 단위 시각, 페르소나 id·상대방 키 없음), 운영자 지표 "공개 프로필·팔로우" 칸(5 미만 가림)(`persona-reports.integration.test.ts`·E2E `s07-persona-reports`, [ADR 0036](../adr/0036-persona-reports-metrics.md)) | §4.5의 사칭 처리 기준을 이용 규칙·도움말에 공지. 아래 SQL ⑥(신고·조치 행에 주인 사용자 열 0행, 사칭 사유는 프로필 대상만)·⑦(주인 확인 사유·감사). 분석 접근권한이 `analytics_events`만인지(운영 테이블과 시각으로 잇지 않게, ADR 0036) |

```sql
-- ① social 역할: 로그인 불가, 커뮤니티 구역 테이블 권한 0행이어야 함(목록은 schema.ts 커뮤니티 구역)
select rolname, rolcanlogin from pg_roles where rolname = 'peerchive_social';
select table_name, privilege_type from information_schema.role_table_grants
where grantee = 'peerchive_social' and table_name in ('community_spaces','space_memberships','boards','space_invitations','official_page_requests',
  'name_mode_changes','community_notices','community_posts','community_comments','thread_aliases','community_reactions','community_author_lookups',
  'community_sanction_requests','community_sanctions','recruitments','recruitment_applications','archive_transfers','archive_transfer_consents','study_records');
-- ② 익명 글·댓글에 페르소나가 붙은 행, 익명 글을 가리키는 페르소나 활동(모두 0이어야 함)
select (select count(*) from community_posts where name_mode = 'anonymous' and persona_id is not null)
     + (select count(*) from community_comments where name_mode = 'anonymous' and persona_id is not null)
     + (select count(*) from persona_activities a join community_posts p on p.id = a.source_id
        where a.source_type = 'community_post' and p.name_mode = 'anonymous') as must_be_zero;
-- ③ 투영·귀속 트리거가 있는지(4개)
select tgname from pg_trigger where tgname in ('persona_activities_projection_guard','community_posts_persona_attribution','community_comments_persona_attribution','community_posts_frozen_columns');
-- ④ S-05: 원본이 더는 공개 상태가 아닌데 거두지 않은 활동(0이어야 함 — 읽기 경로도 거르지만 거두기 트리거가 빠졌는지 확인)
select source_type, count(*) from persona_activities a
where a.withdrawn_at is null and not persona_activity_source_ok(a.persona_id, a.source_type, a.source_id) group by source_type;
-- ⑤ S-05: 거두기 트리거가 있는지(6개)
select tgname from pg_trigger where tgname in ('community_posts_persona_activity_sync','community_spaces_persona_activity_sync','senior_notes_persona_activity_sync',
  'profile_posts_persona_activity_sync','publication_candidates_persona_activity_sync','consents_persona_activity_sync');
-- ⑥ S-07: 페르소나·글·링크 신고·조치가 주인 사용자를 함께 가리키지 않는지, 사칭 사유는 프로필 대상만(모두 0이어야 함)
select (select count(*) from reports where target_type in ('persona','profile_post','social_link') and profile_user_id is not null)
     + (select count(*) from moderation_actions where kind in ('hide_persona','hide_profile_post','hide_social_link') and profile_user_id is not null)
     + (select count(*) from reports where reason = 'impersonation' and target_type not in ('persona','profile')) as must_be_zero;
-- ⑦ S-07: 주인 확인은 모두 신고와 이어지고 사유가 있으며, 감사 metadata에는 id만(사유·주인 없음)
select count(*) from persona_owner_lookups where char_length(reason) < 5;  -- 0이어야 함(너무 짧은 사유는 운영 회의에서 검토)
select metadata from audit_events where action = 'persona.owner_lookup' order by at desc limit 20;
```

### GA: 졸업생·토픽·기관(P2) 개방 — 기능 플래그

P2 기능은 코드가 있어도 **기본으로 꺼져 있고** 이 게이트(DELIVERY_PLAN §7 GA)를 통과한 뒤에 배포 설정으로 켭니다([ADR 0037](../adr/0037-institutions.md) §1). 꺼진 영역의 새 API는 404, 화면 진입점은 숨김입니다. 기존 기능(C-01 학교 메일 인증 등)은 플래그와 무관합니다.

| 변수 | 영역 | 켜기 전 확인 |
|---|---|---|
| `PEERCHIVE_FEATURE_P2_INSTITUTIONS=on` | 기관 확장(I-01 초대 코드·기수 승인·수료증 확인, 이후 I-02) | GC 통과·§6.1 근거, 협력 기관 확보(제품 기획 §19 질문 13), **수료증 파일 삭제 절차 검토**(아래 §4.6·§8, worker `certificate-files`가 돌고 있는지 `/operator/metrics` 시스템 상태에서 확인), 수료증 확인 담당 운영자 지정, 기관 운영진 권한 범위 검토(I-02) |
| `PEERCHIVE_FEATURE_P2_ALUMNI=on` | 졸업생 공간(A-01 동문회·OB 방·방별 프로필, A-02 일정·참석·공지 읽음·투표·앨범, A-03 멤버 명부 동의, A-04 공감 라운지 이미지·졸업생 인증 이력 열람) | A-03 명부 회귀 테스트(`member-directory.integration.test.ts`: 동의 없는 행 0건·항목별 비우기·철회·나가기 즉시 삭제·내보내기 경로 없음·쪽 크기·조회 rate limit, [ADR 0040](../adr/0040-member-directory.md)) 통과, 함께 열 동문 모임 확보, 방별 프로필·모임 도구·명부 경계(S-02 속성 테스트에 alumni 방·일정·투표·명부 포함, [ADR 0038](../adr/0038-alumni-rooms.md)·[0039](../adr/0039-alumni-events.md)) 통과 확인, **앨범 사진 검사 큐 `album-photo-scan`과 라운지 미디어 검사 큐 `post-media-scan`이 도는지**(worker 시작 로그·dead-letter `album-photo-scan-dead`·`post-media-scan-dead` 없음), A-04 회귀 테스트(`lounge-media.integration.test.ts`: 읽는 사람만 서명 URL·가린·지운 글 404·한도·졸업생 이력 열람과 해제 이력 제외, [ADR 0041](../adr/0041-lounge-media-alumni-access.md)) 통과 |
| `PEERCHIVE_FEATURE_P2_TOPICS=on` | 토픽·소속 표시 익명(A-05·A-06) | A-05 임계값·S-02 확장 회귀 테스트 |
| `PEERCHIVE_FEATURE_P2=on` | 위 셋 모두(영역 변수 `off`가 우선) | 위 모두 |

- 값은 `on`·`1`·`true`·`yes`만 켜짐, 그 밖은 꺼짐. web은 요청마다 읽으므로 바꾼 뒤 web을 재시작합니다. 확인: `curl -s https://<사이트>/api/v1/features` → `{"alumni":false,"topics":false,"institutions":true}`.
- 끄기(되돌리기): 변수를 지우고 재시작하면 새 경로가 다음 요청부터 404입니다. 이미 만든 소속은 그대로 active이고(다시 켜면 그대로 보임), 이미 올라온 수료증 파일은 worker가 계속 지웁니다.
- `alumni`를 끄면 이미 만든 동문회·OB 방은 일반 방처럼 보입니다(방별 프로필 API 404, 글의 방별 이름·배지 없음). 방별 프로필 행은 지우지 않으므로 다시 켜면 그대로 보입니다. 나가기·탈퇴·익명 전환에 따른 방별 프로필 삭제는 플래그와 무관하게 돕니다(삭제 장부 종류 `room_profiles`·`room_profile_cohort_changes`·`room_profile_cohort_actors`).
- A-02 모임 도구도 같습니다: 끄면 일정·투표·앨범·공지 읽음 API가 404, 글에 읽음 수가 없고, 행·사진 파일은 그대로 남아 다시 켜면 보입니다. 나가기·내보내기에 따른 참석 응답·공지 읽음·투표 표 삭제와 탈퇴 정리(삭제 장부 종류 `room_event_rsvps`·`notice_reads`·`room_poll_votes`·`room_album_photos`·`room_gathering_actors`)는 플래그와 무관하게 돕니다. 공지 읽음은 누가 읽었는지 보는 화면·API가 없습니다(운영자 포함, [ADR 0039](../adr/0039-alumni-events.md)).
- A-03 멤버 명부도 같습니다: 끄면 명부 API가 404이고 동의 행은 남아 다시 켜면 보입니다. 철회·나가기·내보내기·익명 방 전환에 따른 명부 행 삭제와 탈퇴 정리(삭제 장부 종류 `directory_entries`)는 플래그와 무관하게 돕니다. 명부를 내보내는(CSV·PDF·일괄 조회) 경로는 운영자에게도 없습니다. 명부 쪽 보기가 사용자별 10분에 20쪽을 넘으면 429(rate limit 키 `directory_page_view`) — “명부가 안 넘어가요” 문의는 10분 뒤 다시 보라고 안내합니다([ADR 0040](../adr/0040-member-directory.md)).
- A-04도 같습니다: 끄면 라운지 미디어 API 4개가 404, 글 응답에 이미지가 없고, **졸업생 인증 이력은 세지 않아 공식 페이지 열람은 active 학교 인증만**(기존 동작 — 이력만 있는 졸업생은 공식 페이지·졸업생 게시판이 다시 404). 미디어 행·파일은 남아 다시 켜면 보입니다. 지운 글·끝나지 않은 올리기·통과 못 한 미디어 정리와 탈퇴 정리(삭제 장부 종류 `community_post_media`)는 플래그와 무관하게 돕니다. 짧은 영상은 아직 받지 않습니다(`video/*` 422) — “영상이 안 올라가요” 문의에는 이미지만 된다고 안내합니다. 이력으로 읽는 졸업생이 “글을 못 써요”라고 하면 정상입니다(쓰기는 active 인증 — 학교 메일이 살아 있으면 다시 인증, [ADR 0041](../adr/0041-lounge-media-alumni-access.md) §7). 가린 글의 이미지는 이의제기로 되돌릴 수 있게 파일을 남기지만 아무에게도(글쓴이 포함) 보이지 않습니다.

## 3. 사고 대응

공통: 처음 5분 안에 "막기"부터 합니다. 원인 조사는 막은 뒤에 합니다. 모든 조치는 감사 기록(`/operator/audit`)에 남고, 사고 기록(시각·범위·조치·후속)은 `<사고 기록 위치>`에 둡니다.

### 3.1 개인정보·비공개 자료 누출(권한 오류·파일 공개 오류)

1. **공개 읽기 전체 차단**: `PEERCHIVE_PUBLIC_READS_DISABLED=1`로 web 재시작 → `/api/v1/public/**` 503, 공개 페이지 "잠시 볼 수 없음"(DB 접근 없음). 로그인 화면·작업 공간은 그대로.
2. 원인이 비공개 작업 공간 쪽(공개 경로 밖)이면 **점검 모드** `PEERCHIVE_MAINTENANCE=1`로 전체를 막습니다.
3. 특정 사례만이면 스위치를 풀고 운영자 조치 `restrict`(즉시, 재시작 없음)·`hide_item`.
4. 당사자에게 알림(`<연락 방법·기한>`), 필요한 신고·통지 의무 확인(`<법무 검토 담당>`).
5. 원인 수정·테스트 추가 뒤 스위치 해제. 외부 검색 캐시·이미 받은 파일은 회수하지 못한다고 안내합니다.

### 3.2 잘못된 게시(동의 없는 내용·답안 공유·저작권)

1. 신고가 있으면 개인정보·저작권 신고는 이미 보류(hold)로 새 게시가 막혀 있습니다.
2. 운영자 화면에서 `restrict`(공개 전체) 또는 `hide_item`(항목만). 즉시 반영됩니다.
3. owner·당사자에게 사유(`publicReason`) 전달, 이의제기 경로 안내(ADR 0015).

### 3.3 DB 손실·손상

**복구 순서(바꾸지 마세요)**: 복구 → 삭제 재적용 → 트래픽 열기.

1. web·worker·bot 정지. 남아 있는 DB에 접속할 수 있으면 최신 장부를 먼저 내보냅니다: `DATABASE_URL=<기존> pnpm ops:export-ledger --out=ledger-now.jsonl`. 접속할 수 없으면 가장 최근 백업의 `ledger.jsonl`(또는 별도로 보관한 장부 내보내기)을 씁니다.
2. 새 DB로 복구: `DATABASE_URL=<서버의 아무 DB> ops/restore.sh --from <백업 디렉터리> --target-db <새 이름> --storage-dir <새 저장소>`(이미 있으면 `--force` 없이는 멈춤).
3. web을 `DATABASE_URL=<새 DB> PEERCHIVE_MAINTENANCE=1`로 시작(헬스 확인만 열림). worker는 아직 끔.
4. `DATABASE_URL=<새 DB> PEERCHIVE_STORAGE_ROOT=<새 저장소> pnpm ops:reapply-deletions --ledger-file=ledger-now.jsonl` → `matched`·`repurged` 확인. 다시 돌려 `repurged=0` 확인.
5. `pnpm db:migrate`(새 DB, 대개 할 일 없음) → worker 시작 → `/operator/metrics` 상태 확인.
6. `PEERCHIVE_MAINTENANCE`를 빼고 web 재시작. bot 시작.
7. 백업 시각 이후의 작업(최대 24시간, RPO)은 사라졌음을 사용자에게 안내합니다. 그 사이의 탈퇴 요청은 다시 요청해 달라고 안내합니다.

### 3.4 파일 저장소 손실

1. 공개 파일이 404가 되므로 우선 그대로 두거나(내용은 노출되지 않음) 점검 모드.
2. filesystem: 가장 최근 백업의 `storage.tar.gz`를 풀기: `ops/restore.sh`는 DB와 함께 풀므로, 저장소만이면 `tar -C <저장소> -xzf <백업>/storage.tar.gz`(비어 있는 디렉터리에).
   s3: `ops/backup.sh`의 `storage.tar.gz`는 비어 있습니다(manifest `storage=s3-provider-side`). 공급자의 버전 관리로 지워진 객체의 이전 버전을 되살리거나 복제본 버킷으로 `PEERCHIVE_S3_*`를 바꿉니다. 키 이름(`<prefix>quarantine/…`, `<prefix>clean/…`)은 그대로여야 합니다.
3. DB가 더 새롭다면 백업 뒤 올린 파일은 없습니다: 그 버전은 내려받기 404이고, 사용자에게 다시 올리도록 안내합니다. 그 뒤 `pnpm ops:reapply-deletions`로 탈퇴 정리를 다시 적용합니다(복구된 파일 중 지워야 할 것).

### 3.5 worker 정지

증상: 상태 화면의 worker "응답 없음"(3분 넘게 기록 없음), 파일 검사 대기, 검색 색인 지연, outbox 미전달 증가.
1. 공개 안전성은 영향 없음: 공개 읽기는 worker에 기대지 않고 요청마다 상태를 확인합니다(철회도 즉시).
2. 로그 확인 → 재시작(`pnpm --filter worker start`). 시작 실패면 대개 설정 오류(검사기·저장소·삭제 pepper)입니다.
3. 재시작 뒤 outbox가 줄어드는지, dead-letter(`artifact-scan-dead`)가 생겼는지 확인. dead-letter 파일은 `rescan` API로 다시 검사합니다.
4. 정지 기간이 유예 기간보다 길었으면 "정리가 늦은 탈퇴 계정"이 0이 될 때까지 확인합니다.

### 3.6 디스코드 봇 토큰·내부 비밀 노출

1. 디스코드 개발자 포털에서 봇 토큰 재발급 → `DISCORD_BOT_TOKEN` 교체 → bot 재시작.
2. `PEERCHIVE_INTERNAL_SECRET`을 새 무작위 값으로 바꾸고 **web과 bot을 같이** 재시작(다르면 내부 API 401).
3. 노출 기간의 감사 기록(`discord.*`, `log.create` source discord) 확인. 잘못 만들어진 로그가 있으면 당사자에게 알림.
4. 급하면 web에서 `PEERCHIVE_INTERNAL_SECRET`을 비워 내부 API를 끕니다(503).

### 3.7 정리 작업이 멈춤(`halted`)

`orphan-quarantine`이 `orphan_ratio_too_high`로 멈췄다면 worker가 다른 DB나 다른 저장소를 보고 있을 수 있습니다. `DATABASE_URL`·`PEERCHIVE_STORAGE_ROOT`(s3면 `PEERCHIVE_S3_BUCKET`·`PEERCHIVE_S3_PREFIX`)를 확인하기 전에는 강제로 지우지 마세요.

### 3.8 로그인 메일이 오지 않음

1. 응답은 언제나 202라 화면으로는 구분되지 않습니다. web 로그의 `[auth] magic link mail failed (transport=smtp, code=…, responseCode=…)`와 감사 이벤트 `mail.send_failed`(주소 없음, 코드만)를 봅니다.
2. `EAUTH`/535: SMTP 자격 증명 만료·변경 → 비밀 교체 후 web 재시작. `ETLS`/`ESOCKET`/`ETIMEDOUT`/`ECONNECTION`: 공급자 장애·방화벽·포트(465/587) 확인. 5xx `RCPT`: 수신 주소 거부(사용자 주소 확인).
3. 실패가 없는데 안 온다면 수신 쪽 스팸함과 공급자 화면의 반송·차단 기록, SPF·DKIM·DMARC 통과 여부(§1.1)를 확인합니다.
4. 재시도 큐는 없습니다. 사용자가 다시 요청하면 새 링크가 갑니다(이메일당 15분 5회 한도).

## 4. 탈퇴·삭제 절차

1. 사용자가 탈퇴 요청(`POST /api/v1/me/deletion-request`) → 즉시 로그인 불가·세션 삭제·공개 프로필 404.
2. 유예 기간(기본 7일) 동안 되돌리기는 운영자 수동입니다(화면 없음, `<절차·담당>`).
3. 유예가 지나면 worker `account-purge`가 정리합니다(무엇을 지우고 남기는지는 ADR 0016). 장부에 종류별 개수가 남습니다.
4. 확인: `/operator/metrics`의 "정리가 늦은 탈퇴 계정"이 0인지. 0이 아니면 worker 로그의 `account purge failed`를 봅니다.
5. 공개 사례의 당사자였다면 그 release는 철회되고, 팀은 그 사람을 뺀 새 후보를 만들 수 있습니다.

### 4.1 학교 메일 인증 운영(C-01, ADR 0018)

**파일럿 전: 학교 메일 도메인 등록.** 학생이 만든 학교(ADR 0010)에 운영자가 그 학교의 공식 메일 도메인을 붙여야 학교 메일 인증이 됩니다.

1. 학교 id 찾기: 운영자로 로그인해 `GET /api/v1/schools?q=<학교 이름>`(병합된 학교면 정본 id가 나옴). 같은 학교가 여러 이름으로 있으면 먼저 병합(`POST /api/v1/operator/schools/:id/merge`)합니다.
2. 등록: `pnpm --filter @peerchive/db school-email-domain add <schoolId> <domain>`(또는 `POST /api/v1/operator/schools/:id/email-domains {domain}`). 학교 공식 안내로 도메인을 확인합니다(예: 학생 메일이 `stu.<학교>.ac.kr`이면 `<학교>.ac.kr`을 등록하면 하위 도메인도 인정). `ac.kr` 같은 공용 접미사·웹메일·다른 학교 도메인과 겹치는 값은 거부됩니다.
3. 확인: `pnpm --filter @peerchive/db school-email-domain list <schoolId>`. 실제 학교 메일 한 곳으로 `/settings/affiliations`에서 코드 수신·인증을 확인합니다(스팸함 포함).
4. 잘못 등록했으면 `school-email-domain remove <schoolId> <domain>`. 이미 인증된 소속은 그대로이므로, 잘못된 도메인으로 인증된 계정은 아래 취소로 정리합니다.

**인증 취소(사칭·잘못된 도메인·학교 요청).**

1. 대상 찾기: `GET /api/v1/operator/affiliations?schoolId=<id>` 또는 `?userId=<id>`(사용자 id·학교·도메인·상태·시각만 보임. 메일 주소는 저장돼 있지 않아 운영자도 볼 수 없음).
2. 취소: `POST /api/v1/operator/affiliations/:id/revoke {"reason": "<사유>"}` → 그 소속은 revoked, 다음 요청부터 그 학교 과목 허브에 쓸 수 없음(초안 게시도 막힘). 이미 게시된 선배 노트는 남으므로, 내용 문제는 신고·조치(T-15) 절차로 따로 처리합니다. 사유는 감사 기록(`affiliation.revoke`)에 남습니다.
3. 같은 주소로 다시 인증하는 것은 막지 않습니다(ADR 0018 한계). 반복되면 계정 조치를 검토합니다.

**학생 문의.** "코드가 안 와요" → §3.8과 같은 메일 점검 + 주소별 한도(시간당 3회, 넘으면 응답은 같고 발송만 안 함). "다른 계정에서 인증됐다고 나와요(`email_in_use`)" → 그 주소의 다른 계정에서 해제(`/settings/affiliations`)하거나, 본인 확인 뒤 운영자가 그 소속을 취소합니다. "졸업해서 메일이 없어졌어요" → 인증은 그대로 유지되고 졸업생으로 바꿀 수 있습니다(재인증 없음).

### 4.2 커뮤니티 공식 페이지·공간 운영(C-02, ADR 0019)

커뮤니티는 GC 게이트(DELIVERY_PLAN §7) 전에는 실제 사용자에게 열지 않습니다(2026-10-27 소유자 결정: 구현만 G3 전에 시작). 아래 절차는 시험 환경과 개방 이후에 씁니다.

**공식 학교·학과 페이지 열기.** 운영자만 엽니다. 빈 페이지를 미리 만들지 않고, 요청이 기준(같은 학교 인증 요청자 10명 또는 학생회 요청)에 이르렀거나 pilot 학교 한 곳을 운영자가 먼저 여는 경우(§19)에만 엽니다.

1. 요청 확인: `/operator/community`의 "공식 페이지 개설 요청"(또는 `GET /api/v1/operator/community/official-requests`). 학교·학과별 인증 요청자 수(지금 active 인증인 사람만)·학생회 여부·기준 도달이 보입니다. 기준에 처음 이르면 감사 `community.official_request.threshold`가 남습니다(`GET /api/v1/operator/audit?target=<schoolId>`). 자동으로 열리지 않습니다.
2. 학생회 요청: 학생회(학과 학생회)임을 학교 공지·공식 채널로 확인한 뒤 "학생회 요청으로 표시"(`POST /api/v1/operator/community/official-requests/:id/student-council`). 학번·신분증은 받지 않습니다.
3. 열기: 같은 화면 "공식 페이지 열기" 또는 `POST /api/v1/operator/community/official-pages {"schoolId": "…", "departmentLabel": null|"컴퓨터공학과", "name"?: "…", "description"?: "…"}`. 학교 id는 정본(병합 뒤)이어야 하고, 학교 메일 도메인이 먼저 등록돼 있어야(§4.1) 학생이 들어올 수 있습니다. 학과 페이지는 학생이 학교 인증에 적은 학과와 띄어쓰기·대소문자를 무시하고 같아야 그 학과로 쓰므로, 가장 흔한 표기(요청 목록의 학과 이름)를 씁니다. 기본 게시판 7개(공지는 모더레이터 전용)와 익명 고정으로 열립니다.
4. 모더레이터 지정(학교·학과마다 2~3명, GC 조건은 pilot 학교 2명 이상): `POST /api/v1/operator/community/spaces/:id/moderators {"userId": "…"}`(그 학교 active 인증 필요). 해제는 `DELETE …/moderators/:userId`. 모더레이터도 익명 글의 작성자를 볼 수 없다는 점을 안내합니다.
5. 확인: 그 학교 인증 계정으로 `/community`에 페이지가 보이는지, 다른 학교 인증 계정·미인증 계정은 같은 주소에서 "찾을 수 없습니다"인지 봅니다.

**사용자 방 조치.** 운영자도 사용자 방의 게시판·멤버 목록은 볼 수 없습니다(공간 정보만).

- 사칭(`공식`·학생회 흉내)·괴롭힘 방 신고는 신고 대기열(`/operator`)에 "커뮤니티 공간 · <이름>"으로 들어옵니다. 처리에서 "커뮤니티 공간 제한"을 고르면 멤버는 읽기만 하고 목록·가입·쓰기가 멈춥니다. 이의제기가 받아들여지면 풀립니다.
- 신고 없이 직접: `/operator/community` 공간 목록에서 제한·제한 해제·보관(사유는 감사 `community.space_restrict`·`.space_lift`·`.space_archive`에 남음). 보관은 되돌리지 않습니다.
- 정원 검토: 300명을 넘게 요청한 방은 "정원 검토 요청"으로 보입니다. 운영 여력을 보고 `POST /api/v1/operator/community/spaces/:id/capacity {"capacity": n}`(최대 2000)으로 정합니다. 큰 모임은 공식 페이지로 안내합니다.
- 방장이 탈퇴하면 탈퇴 정리(§4)가 가장 오래된 운영진 → 멤버에게 방장을 넘기고, 남은 사람이 없으면 방을 보관합니다.
- 이름 표시 방식 변경(C-03, ADR 0020): 운영자는 바꾸지 않습니다(방장만 7일 예약, 공식 페이지는 익명 고정). worker `name-mode-changes`(매분)가 기한이 지난 예약을 적용합니다. worker가 멈춰 있어도 웹은 기한부터 새 방식으로 쓰지만, 공간 행·적용 알림은 worker가 맞춥니다. 밀린 예약을 바로 적용하려면 `pnpm --filter worker apply-name-modes`(몇 번 실행해도 됨, 개수만 출력). 상태는 `/operator/metrics`의 `task:name-mode-changes`.

### 4.3 커뮤니티 신고·임시 숨김·작성자 확인·이용 제한(C-06, ADR 0023)

**매일 확인(신고 담당).** `/operator` 대기열 맨 앞의 "임시 숨김 · 우선 검토"부터 봅니다(서로 다른 학교 인증 사용자 3명(방)·5명(공식 페이지)의 신고로 이미 가려진 글·댓글). 목표는 검토 완료까지 중앙값 24시간 이내(DELIVERY_PLAN §6 지표). 그다음 `/operator/community-moderation`의 "방 운영진의 제재 요청"과 `/operator` 아래쪽 "열린 이의제기"(신고와 이어지지 않은 방 운영진 가리기·제재의 이의는 여기서 바로 결정)를 봅니다.

**임시 숨김 처리.** 신고 상세(`/operator/reports/:id`)에서 글·댓글 하나와 신고 사유를 읽고:

1. 문제 없음 → "기각"(메모 필수) 또는 "조치 없음"으로 처리: 다시 보이고 작성자에게 "다시 보이게 되었습니다" 알림. 같은 사람들은 같은 글을 다시 신고할 수 없습니다(신고자·대상마다 한 번).
2. 문제 있음 → "커뮤니티 글/댓글 가리기" + 당사자에게 보일 사유 + 알림: 가림 확정, 작성자는 사유를 보고 한 번 이의를 제기할 수 있습니다.
3. 권리 침해(저작권 등)를 주장하는 **게시 중단 요청**은 이 화면으로 끝내지 않습니다: 우선 가리기로 공개를 막고, 법률 검토를 거친 별도 절차(GC 행 "게시 중단 요청 절차")로 처리합니다. 삭제는 이 화면에 없습니다.

**작성자 확인(익명 글).** 꼭 필요할 때만(제재 판단·법적 요청 대응). 신고 상세 또는 제재 요청의 "작성자 확인·이용 제한"에서 **사유를 적어야** 확인됩니다(예: "방장 제재 요청 #…: 반복 비방 여부 판단"). 확인할 때마다 `community_author_lookups`(사유)와 감사 `community.author_lookup`(누가·어떤 글·근거 id)이 남고, `/operator/community-moderation` "작성자 확인 기록"에서 누구나 사유를 볼 수 있습니다. 결과(작성자 내부 id·핸들)는 그 화면에만 보이고 기록·목록에는 다시 나오지 않으므로, 그 자리에서 제재를 정하지 않으면 나중에 다시 확인(새 기록)해야 합니다. 방장·모더레이터에게 결과를 알리지 마세요(운영 채널·메일 포함). 시간당 20·하루 60회 한도가 있습니다.

**이용 제한 발급.** 확인 결과 아래 폼에서(같은 운영자, 확인 뒤 24시간 안):

| 수준 | 언제 | 효과 |
|---|---|---|
| 경고 | 첫 위반·경미 | 알림만(쓰기 그대로). 이력에 남음 |
| 쓰기 기간 제한(1~365일) | 반복·명백한 괴롭힘·신상 공개 | 범위 "그 공간만"(기본, 방장에게 누구인지 안 보임 — 방 운영 화면에는 "쓰기 제한 n건"만) 또는 "커뮤니티 전체"(방 만들기도 막힘). 기한 뒤 자동 해제 |
| 커뮤니티 영구 제한 | 심각·반복(경고·기간 제한 뒤) | 커뮤니티 전체만. 해제는 이의제기 되돌림 또는 운영자 해제 |

내부 메모(운영자만)와 당사자에게 보일 사유(필수)를 따로 적습니다. 제재는 커뮤니티 글·댓글·공감·방 만들기만 막고 과제 공간·포트폴리오·공개 프로필·과목 허브에는 영향이 없다고 당사자 안내에 함께 나옵니다. 근거가 방장 요청이면 그 요청은 "처리됨(제재가 내려졌습니다)"로 닫히고, 신고는 따로 처리합니다(가리기 여부).

**해제·이의제기.** 제재마다 이의제기 한 번(당사자는 `/me/moderation-notices`에서). 되돌리면 즉시 풀립니다. 운영자 판단으로 풀 때는 `/operator/community-moderation` "이용 제한"에서 해제(메모 필수). 가능하면 발급한 사람이 아닌 운영자가 이의를 결정합니다.

**방 운영진 가리기.** 방장·admin·moderator(공식 페이지는 모더레이터)는 자기 공간 글·댓글을 사유와 함께 가릴 수 있고 운영진 누구나 되돌릴 수 있습니다. 운영자는 `/operator/community-moderation` "방 운영진 가리기"에서 목록을 보고 남용이면 되돌립니다(메모 필수). 운영자가 가린 것(신고 처리)과 겹치면 방 운영진 되돌림으로는 풀리지 않습니다.

**모더레이터 안내(공식 페이지).** 모더레이터도 익명 작성자를 볼 수 없습니다. 제재가 필요하면 글의 "제재 요청"을 쓰라고 안내하고, 결과(누구에게 무엇이)는 알려 주지 않는다는 점을 지정할 때 함께 알립니다(§4.2).

**확인 SQL(개방 직전·월 1회).** 감사 metadata에 사유·이름이 없는지: `select action, metadata from audit_events where action in ('community.author_lookup','community.sanction_issue','community.space_hide','community.sanction_request') order by at desc limit 50`. 사유 없는 확인이 없는지: `select count(*) from community_author_lookups where char_length(reason) < 5`(0이어야 함 — 너무 짧은 사유는 운영 회의에서 검토).

### 4.4 주간 운영 루틴·처리 기한·에스컬레이션(C-10, ADR 0027)

**매일(신고 담당).** `/operator` 대기열을 엽니다. 배지가 처리 기한을 보여 줍니다: 임시 숨김 묶음은 **숨김 시각부터 24시간**, 그 밖의 신고는 **첫 신고부터 72시간**(`PEERCHIVE_REPORT_SLA_AUTO_HIDDEN_HOURS`·`PEERCHIVE_REPORT_SLA_HOURS`, 달력 시간). "곧 기한"(75% 지남)은 그날 처리, "기한 넘김만" 필터(`/operator?status=open&overdue=1`, `in_review`도 같은 필터)가 비어 있어야 합니다. 맡을 때 "나에게 배정"을 누르면 첫 조치 시각이 남습니다(처리 시간 지표).

**매주 월요일(운영자 각자, 15분).**

1. 지난주 운영 시간을 `/operator/ops-time`에 분야별로 적습니다(신고 검토·공식 페이지·학교 인증 지원·큐레이션·기타, 분). 지난주를 놓쳤으면 주(`YYYY-Www`)를 바꿔 적습니다(52주 안). 메모는 본인만 봅니다.
2. 대기열 "기한 넘김만"과 `/operator/metrics`의 "처리 전 신고 묶음"을 확인합니다.
3. `/operator/community-metrics`에서 지난 4주를 보고 GC 측정 점검 표(§2 GC)의 값을 확인합니다. 특정 공간이 의심되면(신고 급증 등) "공간별 보기"에서 그 공간 하나를 고릅니다(active 멤버 20명 이상인 공간만 목록에 나옴, 결과는 개수만).
4. 파일럿 보고용으로 "CSV 내보내기"를 받습니다(집계만, 공간별 값·이름·id 없음, 운영자마다 시간당 10회). 파일은 운영 공유 폴더의 파일럿 보고 위치(`<위치>`)에만 둡니다.
5. 운영 회의(`<요일·채널>`)에서 §9.1 신호(검토 대기 증가, 자동 숨김 → 검토 중앙값 24시간 초과, 주간 검토 시간이 가용 시간 초과)를 봅니다.

**에스컬레이션(기한을 넘긴 임시 숨김).** 임시 숨김 글은 이미 가려져 있어 피해는 멈췄지만, 정상 글이 오래 가려지는 것도 피해입니다.

| 상황 | 대응 |
|---|---|
| 상태 확인 `reports.overdueAutoHidden ≥ 1` | 신고 담당에게 바로 알림(`<운영 채널>`). 대리 운영자가 그날 안에 처리 |
| 기한 넘김이 이틀 연속 또는 5건 이상 | 운영 회의에서 담당·시간 재조정, 필요하면 §9.1 대응(사용자 방 신규 개설 제한, 공식 페이지 쓰기 일시 중지) |
| 자동 숨김 → 검토 중앙값이 2주 연속 24시간 초과 | GC 이후라도 커뮤니티 확대를 멈추고 §9.1 "신고 검토가 운영 여력 초과" 대응 |
| 운영 시간 기록이 2주 이상 비어 있음 | 측정 실패로 보고 운영 회의 안건(GC "주간 시간" 행을 충족하지 못함) |

기한 넘김은 상태 확인의 `status`(ok/degraded)를 바꾸지 않습니다(시스템 장애가 아니라 운영 신호). 외부 감시를 붙이면 `reports.overdueAutoHidden > 0`을 별도 경보로 거세요.

### 4.5 공개 프로필 신고·표시명 사칭·주인 확인(S-07, ADR 0036)

**신고 대상.** 공개 프로필(실명·표시명 모두, 대기열 이름표 `공개 프로필 @handle`, 표시명이면 `(표시명)`), 프로필 글(`프로필 글 · @handle`), 소셜 링크(`소셜 링크 · @handle`). 상세에는 **그 프로필 하나**만 보입니다 — 같은 사람의 다른 프로필(실명 ↔ 표시명)은 보이지 않고, 같은 사람의 두 프로필 신고는 서로 다른 묶음입니다. 처리 기한은 §4.4의 일반 신고(첫 신고부터 72시간)입니다.

**조치.**

| 대상 | 조치 | 효과 | 되돌림 |
|---|---|---|---|
| 공개 프로필 | 이 프로필만 숨기기 | 그 프로필의 `/u/:handle`·README 카드·활동·피드·팔로우 목록에서 다음 요청부터 빠짐. 같은 사람의 다른 프로필은 그대로 | 이의제기 되돌림 |
| 프로필 글 | 프로필 글 숨기기 | 활동 목록·피드에서 빠짐, 본인도 지울 수 없음(근거 보존) | 이의제기 되돌림(다시 활동·피드에) |
| 소셜 링크 | 소셜 링크 숨기기 | 공개 프로필에서 빠짐, 본인 화면에 "운영 조치로 숨김", 지울 수 없음 | 이의제기 되돌림 |

내부 메모(필수)와 당사자에게 보일 사유를 따로 적습니다. 당사자 안내는 `/me/moderation-notices`(알림을 켠 경우)와 프로필 관리 화면입니다.

**표시명 사칭 처리 기준(공지 문구).** 아래를 이용 규칙·도움말에 그대로 공지합니다. 신고 대화상자의 "표시명 사칭" 사유 옆에도 짧게 보입니다.

> 표시명 사칭은 다른 실존 인물(교수·조교·다른 학생·졸업생·공인)이나 학교·학과·기업·단체로 **오인하게 하는** 이름·handle·소개·링크입니다. 이름이 비슷한 것만으로는 사칭이 아니며, 패러디·팬 계정은 프로필에 그 사실이 분명하면 사칭이 아닙니다. 사칭으로 확인되면 그 프로필만 숨기고 사유를 알려 드립니다. 이름·소개를 고친 뒤 이의제기하면 확인해 다시 엽니다. Peerchive는 실명 프로필의 본명이 진짜인지 확인하지 않습니다.

처리 순서:

1. 프로필 하나만 봅니다(이름·handle·소개·소셜 링크). 신고 설명에 "누구를 사칭했는지"가 없으면 "기각"하거나 신고자에게 다시 신고하도록 안내(신고 상태만 보이므로 공지 채널로).
2. 공식 단체·교직원 사칭이 명백하면 바로 숨김 + 사유("다른 사람·단체로 오인하게 하는 이름입니다. 고친 뒤 이의제기하세요"). 개인 학생 사이의 분쟁은 당사자 확인(사칭당한 사람의 학교 메일 등)이 될 때만.
3. 이의제기: 당사자가 이름·handle·소개를 고쳤는지 공개 화면에서 확인하고 되돌립니다. 고치지 않았으면 유지.
4. 같은 사람이 반복하면(새 표시명 프로필은 계정당 하나라 같은 프로필을 고쳐 다시 사칭) 아래 주인 확인 뒤 계정 단위 조치를 검토합니다. 확정 건이 반복되면 §6.2에 따라 표시명 프로필의 기관 인증 배지 필수화를 운영 회의 안건으로 올립니다(`/operator/metrics` "표시명 사칭 신고·숨김 확정").

**주인 확인(계정 단위 조치가 필요할 때만).** 신고 상세의 "주인 확인"에서 **사유를 적어야** 그 프로필의 계정(내부 id·상태)과 그 사람의 다른 프로필이 보입니다. 확인할 때마다 `persona_owner_lookups`(사유)와 감사 `persona.owner_lookup`(신고·확인 id만)이 남고, 결과는 그 화면에만 있습니다(다시 보려면 다시 확인 = 새 기록). 시간당 20회. 신고자·당사자·다른 사용자에게 두 프로필의 연결을 알리지 마세요(본인이 연결을 공개하지 않았다면 그것 자체가 개인정보입니다). 감사 기록 화면은 프로필 주인이 자기 프로필에 한 일(만들기·수정·공개 범위·소셜 링크·차단)의 행위자를 비워 보여 줍니다 — 주인 확인 없이 감사 기록으로 계정을 찾지 마세요.

**계정 단위 조치.** API가 없습니다. 주인 확인 뒤에도 필요하면 운영 회의에서 결정하고, 계정 정지(`users.status = 'suspended'`, 세션 거부 — 두 프로필 모두 404)는 운영 DB 권한자가 기록을 남기고 실행합니다. 다른 프로필만 숨기려면 그 프로필에 대한 신고로 처리합니다(운영자가 직접 신고할 수 있음).

### 4.6 기관·초대 코드·기수 승인·수료증 확인(I-01, ADR 0037)

플래그 `PEERCHIVE_FEATURE_P2_INSTITUTIONS`가 꺼져 있어도 아래 준비(기관·코드 만들기)는 할 수 있지만 사용자는 코드를 쓸 수 없습니다(404).

**기관 만들기.** 대학이 아닌 기관(부트캠프·교육 프로그램·동아리 연합)은 운영자만 만듭니다. 대학은 학생이 만드는 학교이고 학교 메일로만 인증합니다.

```bash
pnpm --filter @peerchive/db institution create bootcamp "피어 부트캠프"     # 출력의 id를 기록
pnpm --filter @peerchive/db institution list [bootcamp|training_program|club_federation]
```

API는 `POST /api/v1/operator/institutions {name, kind}`. 같은 이름의 학교·기관이 있으면 거부합니다. 대학이 아닌 기관은 병합할 수 없으므로 잘못 만들었고 아직 소속·코드가 없으면 DB에서 지웁니다(`delete from schools where id = '<id>' and kind <> 'university' and not exists (select 1 from institution_affiliations where school_id = '<id>') and not exists (select 1 from institution_invite_codes where school_id = '<id>') and not exists (select 1 from institution_cohorts where school_id = '<id>')` — 감사 기록에 사유를 남김). 대학이 아닌 기관에는 공식 커뮤니티 페이지를 I-02 전까지 열지 않습니다(개설 요청이 와도 보류).

**초대 코드 발급·철회(I-02 전까지 운영자).** 협력 기관 담당자와 기수·인원·기간을 정한 뒤 발급합니다.

```bash
# 웹과 같은 PEERCHIVE_AFFILIATION_PEPPER가 필요합니다(다르면 사용자 코드가 맞지 않음). 로컬 개발 DB에서는 NODE_ENV=development로 개발용 값을 씁니다.
pnpm --filter @peerchive/db institution issue-code <institutionId> --max-uses=30 --days=14 --cohort=12기
pnpm --filter @peerchive/db institution list-codes <institutionId>     # 유효·만료·소진·철회, 사용 수
pnpm --filter @peerchive/db institution revoke-code <codeId>
```

- 코드 원문은 발급 출력에 **한 번만** 나옵니다(DB에는 HMAC만). 기관 담당자에게 개인 메시지로 전하고, 운영 채널·티켓에 원문을 남기지 않습니다. 잃어버리면 철회하고 새로 냅니다.
- 사용 한도 1–1000, 기간 1–90일(기본 14). 유출이 의심되면 즉시 철회합니다. 철회해도 이미 그 코드로 인증한 소속은 그대로이므로, 잘못 들어온 계정은 §4.1의 소속 취소(`POST /api/v1/operator/affiliations/:id/revoke`)로 정리합니다(`GET /api/v1/operator/affiliations?schoolId=<기관 id>`).
- 사용자 오류: "만료된/한도를 다 쓴/철회된 초대 코드" → 기관에 새 코드 요청. 시도 한도(사용자 10회·IP 30회/시간)를 넘으면 한 시간 뒤.

**기수 승인 문의·사칭.** 기수 승인은 같은 기수에서 초대 코드·수료증으로 인증된 멤버 2명이 링크로 승인해야 됩니다. 기수 승인으로만 인증된 사람은 승인할 수 없습니다. 30일 안에 승인이 모이지 않으면 만료됩니다. 기수 승인으로 들어온 계정이 사칭으로 판정되면: 그 소속을 취소하고, 승인한 사람을 찾아(`select approver_user_id, approver_affiliation_id, created_at from cohort_approvals where affiliation_id = '<id>'`) 운영 회의에서 승인 자격 제한(그 사람 소속 취소 또는 경고)을 정합니다. 자동 연쇄 취소는 없습니다.

**수료증 확인(운영자 확인 역할).**

1. `/operator/certificates`(플래그가 켜져 있을 때 `/operator`에 링크). 대기 목록은 오래된 것부터입니다. 검사 전·격리된 파일은 열 수 없습니다.
2. "파일 보기(60초)"는 그 운영자에게만 맞는 짧은 서명 URL을 새 창으로 엽니다(보기마다 감사 `certificate_check.view`). **화면 캡처·내려받기·옮겨 적기를 하지 않습니다.** 확인하는 것: 수료증의 이름이 계정 이름과 맞는지, 기관·(있으면) 기수가 맞는지, 위조 흔적.
3. 승인 또는 거절(확인 대화상자). 결정 시각이 남고(처리 시간 지표), 결정 뒤에는 운영자도 파일을 볼 수 없습니다. 판단이 어려우면 결정하지 않고 운영 회의로 넘깁니다(30일 지나면 자동 만료·파일 삭제).
4. 목표 처리 시간: `<시간>`(운영 회의에서 정함). 대기 목록이 쌓이면 §4.4 주간 루틴에서 봅니다.

**수료증 파일 삭제 점검.** worker 주기 작업 `certificate-files`(10분마다, `PEERCHIVE_CRON_CERTIFICATE_FILES`)가 결정·취소·격리·미업로드(하루)·미결정(30일) 파일을 지우고 삭제 장부에 `entity_kind = certificate_file`, `source = retention` 행을 남깁니다(사용자 id 없음, 확인 id의 HMAC). 끄지 않습니다(GA 점검 항목). 점검 SQL:

```sql
-- 결정했는데 1시간 넘게 파일이 남은 수료증(0이어야 함 — 0이 아니면 worker·저장소 상태 확인, §3.5)
select count(*) from certificate_checks where decided_at is not null and file_purged_at is null and decided_at < now() - interval '1 hour';
-- 7일 한도를 넘긴 것(0이어야 함)
select count(*) from certificate_checks where decided_at is not null and (file_purged_at is null or file_purged_at > decided_at + interval '7 days');
-- 최근 삭제 기록(개수만)
select date_trunc('day', purged_at) as day, count(*) from deletion_ledger where source = 'retention' and entity_kind = 'certificate_file' group by 1 order by 1 desc limit 14;
-- 초대 코드 원문 열이 없는지(0행이어야 함)
select column_name from information_schema.columns where table_name = 'institution_invite_codes' and column_name not in ('id','school_id','cohort_id','code_hash','issued_by','expires_at','max_uses','used_count','revoked_at','created_at');
```

백업을 복구한 뒤에는 `pnpm ops:reapply-deletions`가 계정 정리와 함께 `retention` 항목의 수료증 파일도 다시 지웁니다(계정은 건드리지 않음, 출력의 `certificateFiles=`).

## 5. 백업 일정과 보존

| 대상 | 방법 | 주기 | 보존 |
|---|---|---|---|
| DB + 파일 + 장부 + 행 수 | `ops/backup.sh`(pg_dump custom + tar.gz + SHA256SUMS). `PEERCHIVE_STORAGE_DRIVER=s3`면 파일은 넣지 않고 빈 `storage.tar.gz`와 manifest `storage=s3-provider-side`만 남김 | 매일 1회(RPO 24시간) `<시각>` | 14일(`PEERCHIVE_BACKUP_RETENTION_DAYS`) |
| 파일(s3 driver) | 공급자 쪽 버킷 버전 관리 + 이전 버전 보존 규칙(+ 가능하면 다른 지역·계정 복제). 스크립트가 하지 않음(§1.1) | 상시 | `<이전 버전 보존 일수>`(백업 보존과 맞춤) |
| 백업 사본 | 다른 장소(다른 디스크·다른 계정)로 복사 | 백업 직후 | `<보존 기간>` |
| 삭제 장부 | `pnpm ops:export-ledger --out=…` | 백업보다 자주 권장(예: 매시) `<위치>` | 최신 것 유지 |
| 복구 연습 | `ops/restore-drill.sh` | 매월, 그리고 스키마·스크립트 변경 뒤 | 결과를 §6에 기록 |

- 백업에는 개인정보가 있습니다. 백업 디렉터리 접근은 운영자만, 권한 0600/0700(스크립트가 umask 077).
- 로컬 개발 예: `DATABASE_URL=postgres://peerchive:peerchive@localhost:55432/peerchive PEERCHIVE_PG_CONTAINER=peerchive-postgres-1 ops/backup.sh`(컨테이너 안의 pg_dump 사용). 운영에서는 서버 버전과 같은 주 버전의 pg_dump를 쓰고 `PEERCHIVE_PG_CONTAINER`를 비웁니다.
- cron 예(서버): `17 4 * * * cd /srv/peerchive && DATABASE_URL=… PEERCHIVE_BACKUP_DIR=/backup/peerchive ops/backup.sh >>/var/log/peerchive-backup.log 2>&1`

## 6. 복구 연습 결과

`NODE_ENV=development DATABASE_URL=… PEERCHIVE_PG_CONTAINER=peerchive-postgres-1 ops/restore-drill.sh`는 최신 백업을 임시 DB(`peerchive_drill_<시각>`)·임시 저장소로 복구하고, 행 수가 백업 때와 같은지, migration이 모두 적용됐는지, 지금 DB의 장부로 재적용이 되는지(두 번째는 아무것도 바꾸지 않는지) 확인한 뒤 임시 DB·저장소를 지웁니다.

| 날짜 | 환경 | 백업 크기 | 복구 | 행 수 | migration | 재적용 | 합계 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 2026-10-26 | 로컬 개발(Docker PostgreSQL 16, 개발 DB) | 376KB(DB 덤프 약 344KB, 파일 0개) | 1.3초 | 0.1초(58개 표 일치) | 1.5초(16/16) | 3.6초(두 번 실행 포함) | 6.9초 | 백업 뒤 정리된 탈퇴 계정 1명이 복구본에 다시 나타났고 재적용이 다시 지움(장부 대상 5명 중 맞춘 5명, 다시 지운 1명, 대상 장부에 7개 항목 추가). 두 번째 재적용은 바꾼 것 없음. 임시 DB 삭제 확인 |

RTO 목표 4시간 대비 로컬 연습은 수 초입니다. 운영 데이터 규모(최대 약 25GB 원본 파일, DELIVERY_PLAN §10)에서는 파일 압축 풀기·전송이 대부분을 차지하므로 운영 환경에서 같은 연습으로 다시 잽니다.

## 7. 담당·대응 시간(자리)

| 항목 | 목표 초안 | 담당 |
|---|---|---|
| 당번(사고 1차 대응) | 업무 시간 `<…>`, 그 밖 `<…>` | `<이름·연락 채널>` |
| 누출 의심 → 공개 읽기 차단 | 발견 즉시 | 당번 |
| 신고 처리 | apps/README.md "운영" 표, 처리 기한 배지(임시 숨김 24시간·그 밖 72시간, §4.4) | `<운영자>` |
| 주간 운영 시간 기록·지표 확인 | 매주 월요일(§4.4) | 운영자 각자 |
| DB 복구 시작 | 발견 후 1시간 이내, 완료 4시간 이내(RTO) | `<운영자>` |
| 탈퇴 정리 확인 | 매주 상태 화면 확인 | `<운영자>` |
| 복구 연습 | 매월 | `<운영자>` |

## 8. 데이터 보존

| 자료 | 보존 | 정리 |
|---|---|---|
| 세션 | 30일(사용 시 연장), 만료 즉시 정리 대상 | `sessions` 매시 |
| 매직링크 토큰 | 15분 유효, 쓰였거나 만료된 것은 만든 지 7일 뒤 삭제 | `magic-link-tokens` 매일 |
| rate limit 카운터 | 창 시작 48시간 뒤 삭제 | `rate-limit-buckets` 매시 |
| 내부 API nonce | 20분 | `internal-nonces` 10분마다 |
| 디스코드 연결 코드 | 10분 유효, 하루 뒤 삭제 | `discord-codes` 매시 |
| 📌 승인 요청 메시지 내용 | 결정·만료(48시간) 즉시 삭제(행은 남음) | `pin-requests` 10분마다 |
| 업로드 의도 | 15분 유효, 만료 1시간 뒤 삭제 + 격리 파일 | `upload-intents` 15분마다 |
| 주인 없는 격리 파일 | 24시간 | `orphan-quarantine` 매시 |
| 동문회·OB 방 앨범 사진(A-02) | 사진은 올린 사람·방장·운영진이 지우거나 올린 사람이 탈퇴할 때까지(방을 나가도 남음). 내용을 받지 못한 올리기·검사를 통과하지 못한(격리·실패) 사진은 하루 뒤 행과 파일 삭제. 원래 파일 이름은 저장하지 않음, 검사 뒤 메타데이터(EXIF·GPS) 제거 | `upload-intents` 15분마다(함께 정리), 탈퇴 정리 |
| 참석 응답·공지 읽음·투표 표(A-02) | 방을 나가거나 내보내질 때·탈퇴할 때 삭제(읽음 수·집계도 줄어듦). 일정·투표 행은 방의 기록(탈퇴 때 만든 사람만 비움) | 나가기·내보내기 즉시, 탈퇴 정리 |
| 멤버 명부 동의 행(A-03) | 동의한 동안만. 동의 철회·방 나가기·내보내기·익명 방 전환·탈퇴 때 바로 삭제(철회 시각도 남기지 않음). 감사 기록에는 동의·철회 사실과 채운 항목 수만 | 철회·나가기·내보내기 즉시, 이름 표시 방식 적용(worker), 탈퇴 정리 |
| 공감 라운지 미디어(A-04) | 글쓴이가 지우거나 글을 지울 때·탈퇴할 때까지. 지운 글의 미디어는 다음 정리 회차에, 내용을 받지 못한 올리기·검사를 통과하지 못한(격리·실패) 미디어는 하루 뒤 행·파일 삭제. 가린 글의 미디어는 남김(보이지 않음, 이의제기). 감사 기록 없음 | `upload-intents` 15분마다(지운 글·끝나지 않은 올리기·통과 못 함), 탈퇴 정리, `orphan-quarantine`은 미디어 키를 주인 있는 파일로 봄 |
| outbox(전달 완료) | 30일 | `outbox` 매일 |
| 학교 메일 인증 코드 | 10분 유효(5번 틀리면 잠김), 쓰였거나 만료된 지 하루 뒤 삭제. 쓸 코드가 없어진 지 1시간 지난 요청은 expired(메일 해시 삭제) | `affiliation-codes` 매시 |
| 학교 메일 인증(소속) | 메일 주소는 저장하지 않음(해시·도메인만). active는 해제·취소·탈퇴까지, 끝난 행은 해시 없이 이력만 | 탈퇴 정리 때 삭제 |
| 기관 소속·기수 승인 기록(I-01) | 소속은 해제·취소·탈퇴까지, 승인을 다 받지 못한 기수 승인 요청은 30일 뒤 expired. 승인 기록은 탈퇴(승인자·요청자) 때 삭제 | `affiliation-codes` 매시, 탈퇴 정리 |
| 초대 코드(I-01) | 원문 저장 안 함(HMAC만). 행은 기관 기록으로 남김(만료·철회 표시) | 없음 |
| 수료증 파일(I-01) | 결정 뒤 10분 안(최대 7일) 삭제. 취소·대체·격리는 다음 주기, 올리지 않은 요청은 하루, 결정되지 않은 요청은 30일 뒤 삭제·만료. 원래 파일 이름·OCR·번호는 저장하지 않음. 확인 행(결과·결정 시각)은 소속과 함께 탈퇴까지 | `certificate-files` 10분마다(삭제 장부 `retention`), 탈퇴 정리 |
| 탈퇴 계정 자료 | 요청 뒤 7일(유예) | `account-purge` 30분마다 |
| 이름 표시 방식 변경 이력·커뮤니티 알림 | 이력은 공간이 있는 동안(행을 지우지 않음, 탈퇴 때 예약·취소한 사람만 비움), 알림은 받는 사람이 탈퇴할 때까지 | 탈퇴 정리 때. 예약 적용은 `name-mode-changes` 매분 |
| 소셜 링크 | 사용자가 지우거나 탈퇴할 때까지. verified 링크는 `social-link-recheck`(매시, 링크마다 하루 한 번, 한 번에 100개)가 다시 확인해 되돌림 링크가 없으면(404·410 포함) lost, 가져오기 3번 연속 실패면 lost. 감사에는 주소를 남기지 않음 | 탈퇴 정리 때 삭제 |
| 삭제 장부 | 무기한(개인정보 없음, 재적용에 필요). 탈퇴 정리는 사용자 id의 HMAC(`purge`·`reapply`), 수료증 파일은 확인 id의 HMAC(`retention`) | 없음 |
| 분석 이벤트 | 파일럿 기간 `<기간>`, 수집 거부·탈퇴 때 삭제(사용자 키 없는 이벤트 — `actor_hash` null — 는 사람과 이어지지 않아 탈퇴 때 지우지 않음) | 수동(`<절차>`) |
| 주간 운영 시간(`ops_time_entries`) | 파일럿 기간 + 1년(운영 비용 산정 근거, ADR 0027). 탈퇴한 운영자는 메모만 지우고 분은 남김(가명) | 수동: `delete from ops_time_entries where week < '<보존 시작 주>'`(운영 회의 결정 뒤) |
| 지표 CSV 내보내기 | 파일럿 보고 위치 `<위치>`에 보고서 보존 기간 동안(집계만, 개인정보 없음) | 수동 |
| 감사 이벤트 | `<기간>`(본문 없음) | 미구현 |
| pg-boss 작업 기록 | pg-boss 기본 보존 | pg-boss |
| 백업 | 14일 | `ops/backup.sh` |
| 과제·공개 자료 | 사용자가 지우거나 탈퇴할 때까지 | — |
