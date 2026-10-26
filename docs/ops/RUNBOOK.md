# Peerchive 운영 runbook (파일럿)

제한된 파일럿(학생 50명·과제 20개 수준, SYSTEM_DESIGN §14)을 한 사람이 운영한다는 전제의 절차서입니다. 결정 배경은 [ADR 0016](../adr/0016-deletion-ledger-maintenance-analytics.md)(탈퇴 정리·삭제 장부·점검 모드·분석), [ADR 0017](../adr/0017-smtp-mail-and-s3-storage.md)(SMTP 메일·S3 호환 저장소), [ADR 0012](../adr/0012-publish-withdraw-public-read.md)(공개 읽기 운영 스위치), [ADR 0015](../adr/0015-reports-moderation-appeals.md)(신고·조치)를 보세요. 값·명령은 [apps/README.md](../../apps/README.md)의 환경 변수 표와 같습니다.

목표 값은 SLA가 아니라 검증할 설계 목표입니다. 호스팅 공급자·가격은 정하지 않았습니다(DELIVERY_PLAN §10). `<…>` 자리는 파일럿 전에 채웁니다.

## 1. 배포 전 점검표

| 항목 | 확인 | 상태 |
|---|---|---|
| `NODE_ENV` | 지정하지 않거나 `production`(빌드 결과·worker는 기본 production). `development`로 두지 않음 | 운영자 확인 |
| `DATABASE_URL` | 서비스 전용 계정, TLS 접속, 비밀 저장소에서 주입. 0008 migration의 `pg_trgm` 확장 허용 | 운영자 확인 |
| `pnpm db:migrate` | 배포마다 web·worker보다 먼저 | 절차 |
| `NUXT_SITE_ORIGIN` | 실제 https origin(쉼표로 여러 개). 로그인 링크·CSRF 기준 | 운영자 확인 |
| 메일 | `PEERCHIVE_MAIL_TRANSPORT=smtp`, `PEERCHIVE_SMTP_URL`(`smtps://…:465` 또는 `smtp://…:587` STARTTLS 필수, 비밀 저장소), `PEERCHIVE_MAIL_FROM`(발송 도메인의 주소). TLS 없는 SMTP·dev-console·설정 누락이면 web이 시작하지 않음. 공급자 쪽: 발송 도메인 SPF·DKIM·DMARC DNS, 발송 한도, 반송 처리(아래 §1.1) | **구현됨 — 공급자 설정 필요** |
| 파일 저장소 | `PEERCHIVE_STORAGE_DRIVER=s3` + `PEERCHIVE_S3_ENDPOINT`(https)·`_REGION`·`_BUCKET`·`_ACCESS_KEY_ID`·`_SECRET_ACCESS_KEY`(·`_FORCE_PATH_STYLE`·`_PREFIX`), web·worker 같은 값. 설정이 빠졌거나 http endpoint면 web·worker가 시작하지 않음. 공급자 쪽: 비공개 버킷·버전 관리·전용 키(아래 §1.1). 단일 서버 파일럿만 `PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION=1` + 백업 대상 디스크 | **구현됨 — 공급자 설정 필요** |
| 악성코드 검사 | `PEERCHIVE_MALWARE_SCANNER=clamav` + `CLAMAV_HOST/PORT`(signature-only는 production에서 worker가 거부). clamd 서명 갱신 확인 | 운영자 확인 |
| 디스코드 | `PEERCHIVE_INTERNAL_SECRET`(32자 이상 무작위, web·bot 같은 값), `DISCORD_BOT_TOKEN`, 슬래시 명령 등록. 실제 디스코드 연동은 미검증 | 미검증 |
| pepper | `PEERCHIVE_ANALYTICS_PEPPER`, `PEERCHIVE_DELETION_PEPPER` 각각 `openssl rand -hex 32`, 서로 다름. **삭제 pepper는 바꾸지 않음**(재적용이 장부를 못 맞춤). 없으면 분석은 꺼지고 worker는 시작하지 않음 | 운영자 확인 |
| 탈퇴 유예 | `PEERCHIVE_DELETION_GRACE_DAYS`(기본 7). web·worker 같은 값 | 기본값 |
| 공개 색인 | `PEERCHIVE_PUBLIC_INDEXING`은 파일럿 동안 끔(noindex) | 기본값 |
| 프록시 | 프록시·로드밸런서 뒤라면 `PEERCHIVE_TRUSTED_PROXIES`에 프록시 CIDR을 설정(설정하지 않으면 X-Forwarded-For를 무시하고 소켓 주소만 사용). 잘못된 CIDR이 있으면 production에서 서버가 뜨지 않음 | 구현됨 — 배포 환경 CIDR 설정 필요 |
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
| 권한 | 프로젝트 역할 정책·비공개 404·운영자도 비공개 과제 404(T-03·T-10·T-15), 통합 테스트 | E2E 테스트 |
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
| 신고 처리 | apps/README.md "운영" 표 | `<운영자>` |
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
| outbox(전달 완료) | 30일 | `outbox` 매일 |
| 탈퇴 계정 자료 | 요청 뒤 7일(유예) | `account-purge` 30분마다 |
| 삭제 장부 | 무기한(개인정보 없음, 재적용에 필요) | 없음 |
| 분석 이벤트 | 파일럿 기간 `<기간>`, 수집 거부·탈퇴 때 삭제 | 수동(`<절차>`) |
| 감사 이벤트 | `<기간>`(본문 없음) | 미구현 |
| pg-boss 작업 기록 | pg-boss 기본 보존 | pg-boss |
| 백업 | 14일 | `ops/backup.sh` |
| 과제·공개 자료 | 사용자가 지우거나 탈퇴할 때까지 | — |
