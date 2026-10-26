#!/usr/bin/env bash
# Peerchive 복구(T-16, docs/ops/RUNBOOK.md "복구 순서"). backup.sh가 만든 백업을 대상 DB 이름과 저장소 디렉터리로 되살립니다.
#
# 사용: DATABASE_URL=<같은 서버의 아무 DB> [PEERCHIVE_PG_CONTAINER=…] ops/restore.sh --from <백업 디렉터리> --target-db <이름> --storage-dir <디렉터리> [--force]
#   --target-db    만들 DB 이름(소문자·숫자·_). 이미 있으면 --force 없이는 멈춥니다(--force면 지우고 다시 만듦).
#   --storage-dir  파일을 풀 디렉터리. 비어 있지 않으면 --force 없이는 멈춥니다(--force면 기존 것을 <디렉터리>.pre-restore-<시각>으로 옮김, 지우지 않음).
#
# 복구가 끝나도 바로 트래픽을 열지 마세요: 백업 뒤의 탈퇴 정리를 다시 적용해야 합니다.
#   1) web은 PEERCHIVE_MAINTENANCE=1로, worker는 끈 채로
#   2) DATABASE_URL=<대상> PEERCHIVE_STORAGE_ROOT=<저장소> pnpm ops:reapply-deletions --ledger-file=<최신 장부>
#   3) 점검 모드 해제 후 web·worker 시작
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

from="" target="" storage_dir="" force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --target-db) target="${2:-}"; shift 2 ;;
    --storage-dir) storage_dir="${2:-}"; shift 2 ;;
    --force) force=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$from" && -n "$target" && -n "$storage_dir" ]] || die "usage: restore.sh --from <backup dir> --target-db <name> --storage-dir <dir> [--force]"
valid_db_name "$target" || die "invalid target database name: $target"
[[ "$target" != "postgres" && "$target" != template* ]] || die "refusing to restore into $target"
[[ -f "$from/db.dump" && -f "$from/storage.tar.gz" && -f "$from/SHA256SUMS" ]] || die "not a backup directory: $from"
parse_db_url

started="$(now_s)"
log "verify checksums"
(cd "$from" && $(sha256_tool) -c SHA256SUMS >/dev/null) || die "checksum mismatch in $from"

if db_exists "$target"; then
  [[ "$force" -eq 1 ]] || die "database $target already exists (use --force to replace it)"
  log "drop existing database $target (--force)"
  psql_q postgres "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$target' and pid <> pg_backend_pid()" >/dev/null
  psql_q postgres "drop database \"$target\"" >/dev/null
fi
psql_q postgres "create database \"$target\"" >/dev/null
log "restore db → $target"
pg_tool pg_restore -d "$target" --no-owner --no-privileges --exit-on-error <"$from/db.dump"
log "db restored in $(elapsed "$started" "$(now_s)")s"

if [[ -d "$storage_dir" && -n "$(ls -A "$storage_dir" 2>/dev/null)" ]]; then
  [[ "$force" -eq 1 ]] || die "storage directory is not empty: $storage_dir (use --force to move it aside)"
  aside="$storage_dir.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$storage_dir" "$aside"
  log "moved existing storage aside → $aside"
fi
mkdir -p "$storage_dir"
tar -C "$storage_dir" -xzf "$from/storage.tar.gz"
log "storage restored → $storage_dir ($(find "$storage_dir" -type f | wc -l | tr -d ' ') files)"
log "done in $(elapsed "$started" "$(now_s)")s. Next: keep PEERCHIVE_MAINTENANCE=1, run pnpm ops:reapply-deletions against $target, then reopen traffic."
