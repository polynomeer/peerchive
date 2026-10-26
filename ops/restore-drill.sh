#!/usr/bin/env bash
# Peerchive 복구 연습(T-16, SYSTEM_DESIGN §14 "RPO 24시간, RTO 4시간 — DB·파일 복구 + 삭제 ledger 재적용 연습").
# 백업을 같은 서버의 임시 DB와 임시 저장소 디렉터리로 복구하고, 행 수·migration·삭제 재적용을 확인한 뒤 모두 지웁니다.
# 지금 쓰는 DB·저장소는 건드리지 않습니다(임시 DB 이름은 peerchive_drill_<시각>).
#
# 사용: DATABASE_URL=<지금 DB> [PEERCHIVE_PG_CONTAINER=…] ops/restore-drill.sh [--from <백업 디렉터리>] [--ledger-file <장부>] [--keep]
#   --from         기본: PEERCHIVE_BACKUP_DIR(기본 .data/backups)의 가장 최근 백업
#   --ledger-file  재적용에 쓸 장부(기본: 지금 DB에서 내보낸 장부 — 백업 뒤의 정리까지 포함). 백업 안의 장부만 쓰려면 <백업>/ledger.jsonl
#   --keep         끝나도 임시 DB·저장소를 지우지 않음(조사용)
#   재적용은 언제나 임시 filesystem 저장소를 봅니다(PEERCHIVE_STORAGE_DRIVER=s3 환경에서도 운영 버킷을 건드리지 않음).
#   PEERCHIVE_DRILL_DIR  임시 저장소·장부를 둘 곳(기본 TMPDIR). 로컬에서는 NODE_ENV=development를 앞에 붙입니다(재적용 명령의 개발용 pepper·저장소).
# 단계별 시간과 합계를 출력합니다(RTO 근거). 실패하면 종료 코드 1이고, 임시 DB·저장소는 --keep이 아니면 지웁니다.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_db_url

from="" ledger="" keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --ledger-file) ledger="${2:-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
backup_root="${PEERCHIVE_BACKUP_DIR:-$REPO_ROOT/.data/backups}"
if [[ -z "$from" ]]; then
  from="$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20*Z' 2>/dev/null | sort | tail -n 1)"
  [[ -n "$from" ]] || die "no backup found in $backup_root"
fi

stamp="$(date -u +%Y%m%d%H%M%S)"
drill_db="peerchive_drill_$stamp"
work="$(mktemp -d "${PEERCHIVE_DRILL_DIR:-${TMPDIR:-/tmp}}/peerchive-drill.XXXXXX")"
drill_storage="$work/objects"
source_db="$PG_DB"
[[ "$drill_db" != "$source_db" ]] || die "drill database name collides with the source"

cleanup() {
  local code=$?
  if [[ "$keep" -eq 1 ]]; then
    log "kept: database $drill_db, storage $drill_storage"
  else
    psql_q postgres "drop database if exists \"$drill_db\"" >/dev/null 2>&1 || echo "warning: could not drop $drill_db" >&2
    rm -rf "$work"
    log "cleaned up temp database and storage"
  fi
  exit "$code"
}
trap cleanup EXIT

t0="$(now_s)"
step() { log "── $1"; }

step "1/5 restore $(basename "$from") → $drill_db"
s="$(now_s)"
"$REPO_ROOT/ops/restore.sh" --from "$from" --target-db "$drill_db" --storage-dir "$drill_storage" >/dev/null
t_restore="$(elapsed "$s" "$(now_s)")"
log "restore ${t_restore}s"

step "2/5 row counts vs backup"
s="$(now_s)"
diff <(sort "$from/counts.tsv") <(table_counts "$drill_db" | sort) >/dev/null || die "row counts differ from the backup's counts.tsv"
files_expected="$(tar -tzf "$from/storage.tar.gz" | grep -c -v '/$' || true)"
files_restored="$(find "$drill_storage" -type f | wc -l | tr -d ' ')"
[[ "$files_expected" == "$files_restored" ]] || die "storage files differ ($files_restored restored, $files_expected in backup)"
t_counts="$(elapsed "$s" "$(now_s)")"
log "counts ok ($(wc -l <"$from/counts.tsv" | tr -d ' ') tables, $files_restored files) ${t_counts}s"

step "3/5 migrations"
s="$(now_s)"
journal="$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["entries"]))' "$REPO_ROOT/packages/db/migrations/meta/_journal.json")"
applied_before="$(psql_q "$drill_db" "select count(*) from drizzle.__drizzle_migrations")"
(cd "$REPO_ROOT" && DATABASE_URL="$(db_url_for "$drill_db")" pnpm --silent db:migrate >/dev/null 2>&1) || die "migrate failed on the restored database"
applied_after="$(psql_q "$drill_db" "select count(*) from drizzle.__drizzle_migrations")"
[[ "$applied_after" == "$journal" ]] || die "migrations: $applied_after applied, $journal in journal"
t_migrate="$(elapsed "$s" "$(now_s)")"
log "migrations ok (backup had $applied_before, now $applied_after of $journal) ${t_migrate}s"

step "4/5 re-apply deletions"
s="$(now_s)"
if [[ -z "$ledger" ]]; then
  ledger="$work/ledger-current.jsonl"
  ledger_jsonl "$source_db" >"$ledger"
  log "ledger: exported from current database $source_db ($(wc -l <"$ledger" | tr -d ' ') entries)"
fi
reapply_out="$(cd "$REPO_ROOT" && DATABASE_URL="$(db_url_for "$drill_db")" PEERCHIVE_STORAGE_DRIVER=filesystem PEERCHIVE_STORAGE_ROOT="$drill_storage" pnpm --silent ops:reapply-deletions --ledger-file="$ledger" 2>&1)" ||
  { echo "$reapply_out" >&2; die "reapply-deletions failed"; }
echo "$reapply_out" | grep '\[reapply-deletions\]' || true
again="$(cd "$REPO_ROOT" && DATABASE_URL="$(db_url_for "$drill_db")" PEERCHIVE_STORAGE_DRIVER=filesystem PEERCHIVE_STORAGE_ROOT="$drill_storage" pnpm --silent ops:reapply-deletions --ledger-file="$ledger" 2>&1)"
echo "$again" | grep -q 'repurged=0' || die "second reapply was not a no-op"
t_reapply="$(elapsed "$s" "$(now_s)")"
log "reapply ok (second run no-op) ${t_reapply}s"

step "5/5 sanity"
users_left="$(psql_q "$drill_db" "select count(*) from users where status = 'deleted' and purged_at is null and deletion_requested_at is not null")"
log "deleted-but-unpurged accounts in restored DB (purged later by the worker after grace): $users_left"

total="$(elapsed "$t0" "$(now_s)")"
echo
echo "restore drill OK: backup=$(basename "$from") restore=${t_restore}s counts=${t_counts}s migrate=${t_migrate}s reapply=${t_reapply}s total=${total}s (RTO target 4h)"
