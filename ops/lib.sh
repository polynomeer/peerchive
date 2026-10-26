# Peerchive 운영 스크립트 공통 함수(T-16, docs/ops/RUNBOOK.md). backup.sh·restore.sh·restore-drill.sh가 source합니다.
#
# 접속: DATABASE_URL(필수). 비밀번호는 URL에서 읽어 PGPASSWORD로만 넘기고 화면·파일에 쓰지 않습니다.
# PostgreSQL 도구(pg_dump·pg_restore·psql)
#   - PEERCHIVE_PG_CONTAINER가 있으면 그 컨테이너 안의 도구를 docker exec로 씁니다(로컬 개발: peerchive-postgres-1).
#     이때 접속은 컨테이너 안의 localhost:5432입니다(URL의 사용자·비밀번호·DB 이름만 씀).
#   - 없으면 이 컴퓨터의 도구를 DATABASE_URL 그대로 씁니다(서버 버전과 같은 주 버전의 도구를 쓰세요).

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

require_db_url() {
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set"
}

# DATABASE_URL을 나눠 PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DB로 둡니다.
parse_db_url() {
  require_db_url
  local parsed
  parsed="$(python3 -I -c '
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
if p.scheme not in ("postgres", "postgresql"): sys.exit("unsupported DATABASE_URL scheme")
print(u.unquote(p.username or ""))
print(u.unquote(p.password or ""))
print(p.hostname or "localhost")
print(p.port or 5432)
print(u.unquote(p.path.lstrip("/")))
' "$DATABASE_URL")" || die "cannot parse DATABASE_URL"
  { read -r PG_USER; read -r PG_PASSWORD; read -r PG_HOST; read -r PG_PORT; read -r PG_DB; } <<<"$parsed"
  [[ -n "$PG_DB" ]] || die "DATABASE_URL has no database name"
}

# 같은 서버의 다른 DB를 가리키는 URL(드릴의 임시 DB 등).
db_url_for() {
  python3 -I -c '
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
print(u.urlunparse(p._replace(path="/" + sys.argv[2])))
' "$DATABASE_URL" "$1"
}

valid_db_name() { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }

# pg_tool <도구> [인자…]: 대상 DB는 인자로 넘깁니다(-d). 표준 입출력은 그대로 이어집니다.
pg_tool() {
  local tool="$1"; shift
  if [[ -n "${PEERCHIVE_PG_CONTAINER:-}" ]]; then
    docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$PEERCHIVE_PG_CONTAINER" "$tool" -h localhost -p 5432 -U "$PG_USER" "$@"
  else
    PGPASSWORD="$PG_PASSWORD" "$tool" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$@"
  fi
}

# psql_q <db> <sql>: 한 값씩 줄로(머리글 없음).
psql_q() {
  pg_tool psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"
}

db_exists() {
  [[ "$(psql_q postgres "select 1 from pg_database where datname = '$1'")" == "1" ]]
}

# 모든 public 테이블의 정확한 행 수(이름<TAB>개수).
table_counts() {
  psql_q "$1" "select table_name || E'\t' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
    from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
}

# 삭제 장부를 JSON lines로(reapply-deletions --ledger-file 형식).
ledger_jsonl() {
  psql_q "$1" "select json_build_object('subjectHash', subject_hash, 'entityKind', entity_kind, 'count', count,
      'requestedAt', requested_at, 'purgedAt', purged_at, 'source', source)::text
    from deletion_ledger order by purged_at, id"
}

# 저장소 driver(web·worker와 같은 PEERCHIVE_STORAGE_DRIVER). filesystem이 기본입니다.
storage_driver() {
  echo "${PEERCHIVE_STORAGE_DRIVER:-filesystem}"
}

storage_root() {
  local root="${PEERCHIVE_STORAGE_ROOT:-.data/objects}"
  [[ "$root" = /* ]] || root="$REPO_ROOT/$root"
  echo "$root"
}

sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then echo "sha256sum"; else echo "shasum -a 256"; fi
}

# 초 단위 시각(소수점 3자리).
now_s() { python3 -I -c 'import time; print(f"{time.time():.3f}")'; }
elapsed() { python3 -I -c "import sys; print(f'{float(sys.argv[2]) - float(sys.argv[1]):.1f}')" "$1" "$2"; }
