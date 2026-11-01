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
| `PEERCHIVE_FEATURE_P2_INSTITUTIONS=on` | 기관 확장(I-01 초대 코드·기수 승인·수료증 확인, A-06 수료 회고, I-02 기관 페이지·기수 방·기관 운영진) | **A-06 수료 회고 회귀 테스트**(`topic-answer-retros.integration.test.ts`: 별점·연봉·추천 점수 열·숫자형 열·입력 없음, 수료생만, 익명 회고의 두 단계 임계값 고정·넓혀지면 기관 목록 제외·작성자에게만 안내, 기관 인증 계정만 읽음, 신고·`hide_retro`·이의제기, 탈퇴 정리) 통과, 회고 신고 처리 담당 운영자 지정, GC 통과·§6.1 근거, 협력 기관 확보(제품 기획 §19 질문 13), **수료증 파일 삭제 절차 검토**(아래 §4.6·§8, worker `certificate-files`가 돌고 있는지 `/operator/metrics` 시스템 상태에서 확인), 수료증 확인 담당 운영자 지정, **기관 운영진 권한 범위 검토(I-02)**: 회귀 테스트(`institution-staff.integration.test.ts`: 자기 기관 페이지·기수 방에서 모더레이터 범위만·다른 기관 404·작성자 확인 403·멤버 목록·방별 프로필·명부 404·자기 기관 초대 코드만·수료증 403·집계 5 미만 null·기관 단위 사용자 조회 라우트 없음·지정/해제 감사 id만, 도메인 `institution-staff.test.ts`: 운영진 관리 동작 ⊂ 방장) 통과, 협력 기관과 운영진 범위(작성자·사람 조회·내보내기 없음, 기수 방은 운영진이 읽음)를 계약·안내에 적음(DELIVERY_PLAN §9 G4), 운영진 지정 담당 운영자 |
| `PEERCHIVE_FEATURE_P2_ALUMNI=on` | 졸업생 공간(A-01 동문회·OB 방·방별 프로필, A-02 일정·참석·공지 읽음·투표·앨범, A-03 멤버 명부 동의, A-04 공감 라운지 이미지·졸업생 인증 이력 열람) | A-03 명부 회귀 테스트(`member-directory.integration.test.ts`: 동의 없는 행 0건·항목별 비우기·철회·나가기 즉시 삭제·내보내기 경로 없음·쪽 크기·조회 rate limit, [ADR 0040](../adr/0040-member-directory.md)) 통과, 함께 열 동문 모임 확보, 방별 프로필·모임 도구·명부 경계(S-02 속성 테스트에 alumni 방·일정·투표·명부 포함, [ADR 0038](../adr/0038-alumni-rooms.md)·[0039](../adr/0039-alumni-events.md)) 통과 확인, **앨범 사진 검사 큐 `album-photo-scan`과 라운지 미디어 검사 큐 `post-media-scan`이 도는지**(worker 시작 로그·dead-letter `album-photo-scan-dead`·`post-media-scan-dead` 없음), A-04 회귀 테스트(`lounge-media.integration.test.ts`: 읽는 사람만 서명 URL·가린·지운 글 404·한도·졸업생 이력 열람과 해제 이력 제외, [ADR 0041](../adr/0041-lounge-media-alumni-access.md)) 통과 |
| `PEERCHIVE_FEATURE_P2_TOPICS=on` | 토픽·소속 표시 익명(A-05 학교를 넘나드는 토픽·작성 시점 소속 표시·임계값, A-06 현직자 답변 → 선배 노트) | **A-06 이동 회귀 테스트**(`topic-answer-retros.integration.test.ts`: 이름 표시 네 가지, 소속 표시 유지는 원 글 문자열 복사·바꾸기 금지·투영 0건, 실명·표시명은 복사본 노트만 투영·원 글 연결 없음)와 **S-02 확장**(속성 테스트가 토픽 답변을 네 방식으로 옮긴 세계까지, [ADR 0043](../adr/0043-topic-answer-transfer-retros.md)) 통과, **A-05 임계값 회귀 테스트**(`topics.integration.test.ts`: 시나리오 Y — 30명 부트캠프 → `부트캠프 수료생`, 60명 대학 졸업생 → `○○대 · 졸업생`, 표시 안 함 → 없음, 이후 회원 증가·소속 해제에도 표시 그대로, 학과·기수 미표시, 넓혀졌는지는 작성자에게만, 세는 회원 = 정본 기관·같은 신분의 인증된 active 소속 + active 계정, 범주(기관 유형·신분)도 50명 미만이면 표시 안 함) 통과, **S-02 확장 회귀 테스트**(`identity-boundary.integration.test.ts` 속성 테스트에 토픽·소속 표시 익명 글·댓글 포함, 투영 0건, [ADR 0042](../adr/0042-topics-affiliation-labels.md)) 통과, 임계값 값 확인(`PEERCHIVE_AFFILIATION_LABEL_THRESHOLD`, 기본 50·5 미만 불가), 첫 토픽(취준 등) 운영자 준비 |
| `PEERCHIVE_FEATURE_P2=on` | 위 셋 모두(영역 변수 `off`가 우선) | 위 모두 |

- 값은 `on`·`1`·`true`·`yes`만 켜짐, 그 밖은 꺼짐. web은 요청마다 읽으므로 바꾼 뒤 web을 재시작합니다. 확인: `curl -s https://<사이트>/api/v1/features` → `{"alumni":false,"topics":false,"institutions":true}`.
- 끄기(되돌리기): 변수를 지우고 재시작하면 새 경로가 다음 요청부터 404입니다. 이미 만든 소속은 그대로 active이고(다시 켜면 그대로 보임), 이미 올라온 수료증 파일은 worker가 계속 지웁니다.
- `alumni`를 끄면 이미 만든 동문회·OB 방은 일반 방처럼 보입니다(방별 프로필 API 404, 글의 방별 이름·배지 없음). 방별 프로필 행은 지우지 않으므로 다시 켜면 그대로 보입니다. 나가기·탈퇴·익명 전환에 따른 방별 프로필 삭제는 플래그와 무관하게 돕니다(삭제 장부 종류 `room_profiles`·`room_profile_cohort_changes`·`room_profile_cohort_actors`).
- A-02 모임 도구도 같습니다: 끄면 일정·투표·앨범·공지 읽음 API가 404, 글에 읽음 수가 없고, 행·사진 파일은 그대로 남아 다시 켜면 보입니다. 나가기·내보내기에 따른 참석 응답·공지 읽음·투표 표 삭제와 탈퇴 정리(삭제 장부 종류 `room_event_rsvps`·`notice_reads`·`room_poll_votes`·`room_album_photos`·`room_gathering_actors`)는 플래그와 무관하게 돕니다. 공지 읽음은 누가 읽었는지 보는 화면·API가 없습니다(운영자 포함, [ADR 0039](../adr/0039-alumni-events.md)).
- A-03 멤버 명부도 같습니다: 끄면 명부 API가 404이고 동의 행은 남아 다시 켜면 보입니다. 철회·나가기·내보내기·익명 방 전환에 따른 명부 행 삭제와 탈퇴 정리(삭제 장부 종류 `directory_entries`)는 플래그와 무관하게 돕니다. 명부를 내보내는(CSV·PDF·일괄 조회) 경로는 운영자에게도 없습니다. 명부 쪽 보기가 사용자별 10분에 20쪽을 넘으면 429(rate limit 키 `directory_page_view`) — “명부가 안 넘어가요” 문의는 10분 뒤 다시 보라고 안내합니다([ADR 0040](../adr/0040-member-directory.md)).
- A-04도 같습니다: 끄면 라운지 미디어 API 4개가 404, 글 응답에 이미지가 없고, **졸업생 인증 이력은 세지 않아 공식 페이지 열람은 active 학교 인증만**(기존 동작 — 이력만 있는 졸업생은 공식 페이지·졸업생 게시판이 다시 404). 미디어 행·파일은 남아 다시 켜면 보입니다. 지운 글·끝나지 않은 올리기·통과 못 한 미디어 정리와 탈퇴 정리(삭제 장부 종류 `community_post_media`)는 플래그와 무관하게 돕니다. 짧은 영상은 아직 받지 않습니다(`video/*` 422) — “영상이 안 올라가요” 문의에는 이미지만 된다고 안내합니다. 이력으로 읽는 졸업생이 “글을 못 써요”라고 하면 정상입니다(쓰기는 active 인증 — 학교 메일이 살아 있으면 다시 인증, [ADR 0041](../adr/0041-lounge-media-alumni-access.md) §7). 가린 글의 이미지는 이의제기로 되돌릴 수 있게 파일을 남기지만 아무에게도(글쓴이 포함) 보이지 않습니다.
- A-05 토픽: 토픽은 운영자만 엽니다 — 운영자 화면 `/operator/community`의 "토픽 열기"(플래그가 켜졌을 때만) 또는 플래그와 무관한 CLI `pnpm --filter @peerchive/db topic create <career|grad_school|startup|military|campus_life|role> <이름> [--description=소개]`·`topic list`(같은 이름 키면 만들지 않음, 감사 `community.topic_create{kind, category}`). 끄면 토픽 목록·만들기 API와 토픽 공간의 상세·게시판·글·댓글·공감·신고가 모두 404이고 커뮤니티 첫 화면의 토픽 링크가 사라집니다. 토픽 글·소속 표시는 남아 다시 켜면 그대로 보입니다. 운영자 공간 도구(제한·보관)와 작성자 확인(`/operator/community/author-lookups`, 소속 표시 익명 글이면 표시에 쓴 소속 id도 함께 — 사유 기록 경로뿐)은 플래그와 무관합니다. “표시가 학교 이름이 아니라 `대학 졸업생`으로 나와요” 문의에는 그 소속·신분의 인증 회원이 기준(50명)보다 적으면 학교·기관 유형으로, 유형 전체도 50명보다 적으면 소속 없이 자동으로 넓혀 표시하고 이미 쓴 글은 나중에 바뀌지 않는다고 안내합니다(회원 수는 알려 주지 않습니다). 임계값 변경은 `PEERCHIVE_AFFILIATION_LABEL_THRESHOLD`(web 재시작, 새 글부터)이며 낮추기는 GA 게이트와 같은 검토를 거칩니다. 탈퇴 정리는 글·댓글의 소속 id를 비운 뒤 소속 행을 지웁니다(표시 문자열은 작성자 삭제된 글에 남지만 보이지 않음).
- A-06 현직자 답변 이동(`topics`): 토픽의 내 답변(댓글)에 "선배 노트로 옮기기"가 보입니다. 옮긴 노트는 기존 선배 노트처럼 초안 → 답 2개 이상 → 게시이고 과목을 골라야 합니다(그 과목 학교 인증 필요). “과목과 상관없는 커리어 답변은 어떻게 옮기나요” 문의에는 아직 옮길 곳이 없고 토픽에 남는다고 안내합니다. “소속 표시 유지”로 옮긴 노트는 원 글의 표시(예: `○○대학교 · 졸업생`)를 그대로 쓰며 나중에 회원 수·소속이 바뀌어도 바뀌지 않고 프로필 활동에 나오지 않습니다. 선배 노트 신고·숨김은 기존 `hide_note` 그대로이고, 노트 운영 상세에는 원 글이 없습니다(원 글을 봐야 하면 커뮤니티 신고 경로로). 끄면 토픽 공간이 404라 옮기기도 404이고, 이미 옮긴 노트는 과목 허브에 그대로 남습니다.
- I-02 기관 페이지·기수 방·기관 운영진(`institutions`): 기관 페이지는 운영자가 `/operator/community`의 공식 페이지 개설에 기관 id(`/operator/institutions`에서 검색해 보임)를 넣어 엽니다(학과 없음, 게시판 자유·수료생·질문·정보·모집·공지). 협력 기관 확인 전에는 열지 않습니다(개설 요청은 수요 신호일 뿐). 운영진은 `/operator/institutions`에서 기관을 검색해 사용자 id로 지정·해제합니다(감사 `institution_staff.grant`·`.revoke`, id만). 지정 전 기관에 범위를 알립니다: 자기 기관 페이지·기수 방의 가리기·되돌리기·제재 요청·공지·소개·게시판 관리, 자기 기관 초대 코드 발급·철회, 5 미만을 가린 집계뿐이고 **작성자 확인·수료증 확인·소속 사용자 목록·프로필·과제 공간 조회·내보내기는 없습니다**(요청이 오면 거절, 작성자 확인이 필요한 사안은 신고로 운영자에게). 기수 방은 운영진이 `/institutions/manage/:id`에서 기수마다 하나 만들고(방장 없음), 그 기수 인증만 들어옵니다 — 기수 방에서 문제 멤버는 신고·이용 제한(C-06)으로, 방을 닫을 때는 운영자 공간 도구의 보관을 씁니다(보관하면 같은 기수 방을 다시 만들 수 있음). 운영진이 퇴사하면 즉시 해제합니다(다음 요청부터 권한 없음). 끄면 기관 페이지·기수 방·운영진 경로가 404이고 운영진 권한이 사라지며, 행은 남아 다시 켜면 돌아옵니다. 탈퇴 정리는 그 사람의 운영진 행을 지웁니다(장부 `institution_staff`). 점검: `select count(*) from community_spaces where cohort_id is not null and kind <> 'user_room';`(0 — check가 막음), `select s.id from institution_staff s join schools k on k.id = s.school_id where s.revoked_at is null and k.kind = 'university';`(없어야 함).
- A-06 수료 회고(`institutions`): `/community/retros`(기관 인증 계정만 읽음, 공개 검색·검색엔진 없음). 쓰기는 대학이 아닌 기관의 인증된 **수료생**만, 기관마다 하나(철회 후 다시). 별점·연봉·추천 점수는 받지 않습니다 — 그런 내용이 본문에 있거나 강사·운영진 개인을 평가하면 신고로 `hide_retro`(작성자에게 안내·이의제기, 되돌리면 다시 보임) 처리합니다. 익명 회고가 기관 이름 없이 `부트캠프 수료생`(또는 표시 없이)으로 보이는 것은 그 기관(·유형)의 인증 수료생이 기준(50명)보다 적어서이며, 쓴 뒤에는 바뀌지 않습니다(회원 수는 알려 주지 않음). 끄면 회고 API·화면이 404이고 행은 남아 다시 켜면 보입니다. 신고 처리·되돌림과 탈퇴 정리(삭제 장부 종류 `completion_retros`, 신고가 가리키면 익명 빈 철회 행)는 플래그와 무관합니다. 점검: `select count(*) from completion_retros where display_mode = 'anonymous' and (cohort_label is not null or display_name_snapshot is not null);`(0이어야 함 — check가 막음), `select count(*) from persona_activities a join senior_notes n on n.id = a.source_id where a.source_type = 'senior_note' and n.display_mode::text not in ('name', 'display');`(0이어야 함).
