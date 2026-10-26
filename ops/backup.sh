#!/usr/bin/env bash
# Peerchive 백업(T-16, docs/ops/RUNBOOK.md "백업"). DB(pg_dump custom 형식) + 파일 저장소(tar.gz, filesystem driver일 때만) + 삭제 장부 + 행 수 + 체크섬.
#
# 사용: DATABASE_URL=… [PEERCHIVE_PG_CONTAINER=peerchive-postgres-1] ops/backup.sh
#   PEERCHIVE_BACKUP_DIR            백업을 둘 곳(기본: 저장소 루트의 .data/backups). 운영에서는 다른 디스크·다른 장소로 복사하세요.
#   PEERCHIVE_BACKUP_RETENTION_DAYS 이 일수보다 오래된 백업 디렉터리를 지웁니다(기본 14, 0이면 지우지 않음).
#   PEERCHIVE_STORAGE_ROOT          파일 저장소 루트(web·worker와 같은 값, 기본 .data/objects).
#   PEERCHIVE_STORAGE_DRIVER        `s3`이면 파일은 이 스크립트가 백업하지 않습니다(공급자 쪽 버전 관리·복제, RUNBOOK §5).
#                                   storage.tar.gz는 빈 묶음으로 두고 manifest에 storage=s3-provider-side를 적습니다(복구 스크립트 형식 유지).
#
# 결과: <백업 디렉터리>/<UTC 시각>/{db.dump, storage.tar.gz, ledger.jsonl, counts.tsv, manifest.txt, SHA256SUMS}
# 파일 권한 0600(디렉터리 0700). 비밀값(접속 정보)은 어디에도 쓰지 않습니다. 백업에는 개인정보가 있으므로 접근을 제한하세요.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_db_url

backup_root="${PEERCHIVE_BACKUP_DIR:-$REPO_ROOT/.data/backups}"
retention="${PEERCHIVE_BACKUP_RETENTION_DAYS:-14}"
[[ "$retention" =~ ^[0-9]+$ ]] || die "PEERCHIVE_BACKUP_RETENTION_DAYS must be a non-negative integer"
storage="$(storage_root)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$backup_root/$stamp"
[[ -e "$out" ]] && die "backup directory already exists: $out"
mkdir -p "$out"

started="$(now_s)"
log "backup → $out (db=$PG_DB)"

# 1) DB: custom 형식(-Fc, 압축). 소유자·권한은 빼서 다른 계정으로 복구할 수 있게 합니다.
pg_tool pg_dump -d "$PG_DB" -Fc --no-owner --no-privileges >"$out/db.dump"
log "db.dump $(wc -c <"$out/db.dump" | tr -d ' ') bytes"

# 2) 같은 시점에 가까운 행 수와 삭제 장부(복구 확인·재적용용, 개인정보 없음).
table_counts "$PG_DB" >"$out/counts.tsv"
ledger_jsonl "$PG_DB" >"$out/ledger.jsonl"
log "counts.tsv $(wc -l <"$out/counts.tsv" | tr -d ' ') tables, ledger.jsonl $(wc -l <"$out/ledger.jsonl" | tr -d ' ') entries"

# 3) 파일 저장소. 없으면 빈 tar. S3 호환 저장소는 공급자 쪽에서 백업하므로(버전 관리·복제) 빈 tar와 표시만 남깁니다.
driver="$(storage_driver)"
case "$driver" in
  filesystem)
    storage_note="filesystem-tar"
    if [[ -d "$storage" ]]; then
      tar -C "$storage" -czf "$out/storage.tar.gz" .
    else
      tar -czf "$out/storage.tar.gz" -T /dev/null
    fi
    log "storage.tar.gz $(wc -c <"$out/storage.tar.gz" | tr -d ' ') bytes"
    ;;
  s3)
    storage_note="s3-provider-side"
    tar -czf "$out/storage.tar.gz" -T /dev/null
    log "storage: driver=s3 — files are NOT in this backup; rely on bucket versioning/replication (RUNBOOK §5). storage.tar.gz is empty."
    ;;
  *) die "unknown PEERCHIVE_STORAGE_DRIVER: $driver" ;;
esac

{
  echo "created_at=$stamp"
  echo "database=$PG_DB"
  echo "format=pg_dump-custom"
  echo "storage=$storage_note"
  echo "git_rev=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "migrations=$(ls "$REPO_ROOT/packages/db/migrations" | grep -c '\.sql$')"
} >"$out/manifest.txt"

(cd "$out" && $(sha256_tool) db.dump storage.tar.gz ledger.jsonl counts.tsv manifest.txt >SHA256SUMS)
chmod 600 "$out"/*

# 4) 보존 기간: 이름이 백업 시각 형식인 디렉터리만 지웁니다.
if [[ "$retention" -gt 0 ]]; then
  find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9][01][0-9][0-3][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z' -mtime +"$retention" -print -exec rm -rf {} + |
    sed 's/^/removed old backup: /'
fi

log "done in $(elapsed "$started" "$(now_s)")s: $out"
