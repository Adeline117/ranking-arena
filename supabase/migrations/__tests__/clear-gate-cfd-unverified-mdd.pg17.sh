#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261125183157: the max drawdown stored for gate_cfd
# traders is archived and cleared, and nothing else changes.
#
#   + every non-NULL gate_cfd trader_stats.mdd (every timeframe) is archived
#     with the row's as_of and the reason, then set to NULL
#   = other gate_cfd columns, other sources' rows and gate_cfd rows without an
#     mdd are unchanged
#   + with the real attestation triggers installed, the clear is accepted and
#     'mdd' leaves the board and profile attested-metric lists; other attested
#     metrics stay
#   + the board write (headline-stats-sql.ts) with a NULL mdd keeps the
#     cleared NULL and no longer freezes as_of; before the cleanup it froze it
#   = a replay archives and clears nothing; the archive is append-only and
#     owner-only
# The migration is applied by a non-superuser owner. Isolated cluster on a
# private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
EVIDENCE_MIGRATION="$MIGRATIONS/20261116205144_trader_stats_score_input_evidence_pointer.sql"
PROFILE_MIGRATION="$MIGRATIONS/20261116215328_profile_acquisition_evidence_ledger.sql"
NEW_MIGRATION="$MIGRATIONS/20261125183157_clear_gate_cfd_unverified_mdd.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/clear-gate-cfd-mdd-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((53000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -40 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_as() {
  local role="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

# Prints one function definition from a migration: from the line that starts
# with $2 through the closing "$function$;".
function_of() {
  FIRST_LINE="$2" awk '
    !printing && index($0, ENVIRON["FIRST_LINE"]) == 1 { printing = 1 }
    printing { print }
    printing && $0 == "$function$;" { exit }
  ' "$1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U bootstrap --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_as bootstrap -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon NOSUPERUSER;
CREATE ROLE authenticated NOSUPERUSER;
CREATE ROLE service_role LOGIN NOSUPERUSER;
GRANT CREATE ON DATABASE postgres TO postgres;
SQL

psql_as postgres -q <<'SQL'
CREATE SCHEMA arena;
CREATE TABLE arena.sources (id smallint PRIMARY KEY, slug text NOT NULL UNIQUE);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id)
);
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (0, 7, 30, 90)),
  as_of timestamptz NOT NULL,
  currency text NOT NULL,
  roi numeric, pnl numeric, sharpe numeric, mdd numeric, win_rate numeric,
  win_positions int, total_positions int, copier_pnl numeric, copier_count int,
  aum numeric, volume numeric, profit_share_rate numeric,
  holding_duration_avg interval, trading_preferences jsonb,
  extras jsonb NOT NULL DEFAULT '{}',
  evidence_raw_object_id bigint, evidence_source_run_id text, evidence_metrics text[],
  profile_evidence_attempt_seq bigint, profile_evidence_metrics text[],
  PRIMARY KEY (trader_id, timeframe)
);
SQL

# The two attestation triggers exactly as production defines them.
{
  function_of "$EVIDENCE_MIGRATION" 'CREATE OR REPLACE FUNCTION arena.trader_stats_score_input_value('
  function_of "$EVIDENCE_MIGRATION" 'CREATE OR REPLACE FUNCTION arena.trader_stats_score_input_evidence()'
  function_of "$PROFILE_MIGRATION" 'CREATE FUNCTION arena.trader_stats_profile_evidence()'
  cat <<'SQL'
CREATE TRIGGER trader_stats_score_input_evidence
  BEFORE INSERT OR UPDATE ON arena.trader_stats
  FOR EACH ROW EXECUTE FUNCTION arena.trader_stats_score_input_evidence();
CREATE TRIGGER trader_stats_profile_evidence
  BEFORE INSERT OR UPDATE ON arena.trader_stats
  FOR EACH ROW EXECUTE FUNCTION arena.trader_stats_profile_evidence();
SQL
} >"$TMP_ROOT/triggers.sql"
psql_as postgres -q -f "$TMP_ROOT/triggers.sql"
assert_equal "both attestation triggers are installed on arena.trader_stats" "2" \
  "$(psql_as postgres -Atqc "
     SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'arena.trader_stats'::regclass AND NOT tgisinternal")"

psql_as postgres -q <<'SQL'
INSERT INTO arena.sources VALUES (1, 'gate_cfd'), (2, 'gate_futures');
INSERT INTO arena.traders VALUES (10, 1), (11, 1), (12, 1), (20, 2);
-- Rows are inserted without attestation pointers (the profile trigger would
-- look the attempt up), then the pointers are set by a direct update: an
-- unchanged attempt seq keeps the listed metrics that hold a value.
INSERT INTO arena.trader_stats
  (trader_id, timeframe, as_of, currency, roi, pnl, mdd, win_rate, sharpe)
VALUES
  (10, 7,  '2026-11-25 10:00+00', 'USDx', -74.9, -749, 0,    40, 0),
  (10, 30, '2026-11-25 10:00+00', 'USDx', 38.6, 28390, 0,    73.33, 0),
  (10, 90, '2026-11-24 09:00+00', 'USDx', 12.5, 900,  4.2,   55, 1.1),
  (11, 30, '2026-11-25 10:00+00', 'USDx', 5, 50,      NULL,  60, NULL),
  (12, 7,  '2026-11-25 10:00+00', 'USDx', -3, -30,    1.5,   50, NULL),
  (20, 30, '2026-11-25 10:00+00', 'USDT', 14.49, 11189, 29.7, 65, 1.3);
UPDATE arena.trader_stats
   SET evidence_raw_object_id = 1, evidence_source_run_id = 'run',
       evidence_metrics = ARRAY['mdd', 'roi', 'pnl']
 WHERE trader_id IN (10, 20);
ALTER TABLE arena.trader_stats DISABLE TRIGGER trader_stats_profile_evidence;
UPDATE arena.trader_stats
   SET profile_evidence_attempt_seq = 77, profile_evidence_metrics = ARRAY['mdd', 'win_rate']
 WHERE trader_id = 12;
ALTER TABLE arena.trader_stats ENABLE TRIGGER trader_stats_profile_evidence;
SQL

snapshot() {
  psql_as postgres -Atqc "
    SET TIME ZONE 'UTC';
    SELECT string_agg(
             trader_id || '/' || timeframe || ':' || coalesce(mdd::text, '-') || ':' ||
             roi || ':' || pnl || ':' || win_rate || ':' || coalesce(sharpe::text, '-') || ':' ||
             as_of || ':' || coalesce(array_to_string(evidence_metrics, ','), '-') || ':' ||
             coalesce(array_to_string(profile_evidence_metrics, ','), '-'),
             ' ' ORDER BY trader_id, timeframe)
      FROM arena.trader_stats"
}

BEFORE="$(snapshot)"
assert_equal "fixture: attestations as set up" \
  "mdd,pnl,roi" "$(psql_as postgres -Atqc "SELECT array_to_string(evidence_metrics, ',') FROM arena.trader_stats WHERE trader_id = 10 AND timeframe = 7")"

# Before the cleanup: the board write with a NULL mdd keeps the stored value
# and freezes as_of at the older time (rolled back).
BOARD_WRITE="
  INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, roi, pnl, mdd)
  VALUES (10, 7, '2026-11-25 12:00+00', 'USDx', -70, -700, NULL)
  ON CONFLICT (trader_id, timeframe) DO UPDATE SET
    as_of = CASE WHEN (EXCLUDED.mdd IS NULL AND arena.trader_stats.mdd IS NOT NULL)
                 THEN LEAST(arena.trader_stats.as_of, EXCLUDED.as_of) ELSE EXCLUDED.as_of END,
    roi = COALESCE(EXCLUDED.roi, arena.trader_stats.roi),
    pnl = COALESCE(EXCLUDED.pnl, arena.trader_stats.pnl),
    mdd = COALESCE(EXCLUDED.mdd, arena.trader_stats.mdd)"
assert_equal "before: a NULL board mdd keeps the stored 0 and freezes as_of" \
  "0|2026-11-25 10:00:00+00" \
  "$(psql_as postgres -Atqc "SET TIME ZONE 'UTC'; BEGIN; $BOARD_WRITE;
     SELECT mdd || '|' || as_of FROM arena.trader_stats WHERE trader_id = 10 AND timeframe = 7;
     ROLLBACK;" | grep '|')"

psql_as postgres -q -f "$NEW_MIGRATION" 2>"$TMP_ROOT/apply.err" >/dev/null
grep -q 'gate_cfd trader_stats rows with a stored mdd: 4' "$TMP_ROOT/apply.err"
grep -q 'gate_cfd mdd cleanup: cleared 4 rows, archived 4' "$TMP_ROOT/apply.err"
echo "ok: preflight counted 4 rows; postflight cleared 4 and archived 4"

assert_equal "the archive holds each cleared value with its as_of and reason" \
  "10/7:0:2026-11-25 10:00:00+00:gate_cfd_max_drawdown_unverified 10/30:0:2026-11-25 10:00:00+00:gate_cfd_max_drawdown_unverified 10/90:4.2:2026-11-24 09:00:00+00:gate_cfd_max_drawdown_unverified 12/7:1.5:2026-11-25 10:00:00+00:gate_cfd_max_drawdown_unverified" \
  "$(psql_as postgres -Atqc "SET TIME ZONE 'UTC';
     SELECT string_agg(trader_id || '/' || timeframe || ':' || cleared_mdd || ':' || stats_as_of || ':' || reason,
                       ' ' ORDER BY trader_id, timeframe)
       FROM arena.trader_stats_cleared_mdd" | tail -1)"

# Only mdd and the 'mdd' attestations change; gate_futures (20) and the
# gate_cfd row without an mdd (11/30) are untouched.
assert_equal "before: the fixture rows" \
  "10/7:0:-74.9:-749:40:0:2026-11-25 10:00:00+00:mdd,pnl,roi:- 10/30:0:38.6:28390:73.33:0:2026-11-25 10:00:00+00:mdd,pnl,roi:- 10/90:4.2:12.5:900:55:1.1:2026-11-24 09:00:00+00:mdd,pnl,roi:- 11/30:-:5:50:60:-:2026-11-25 10:00:00+00:-:- 12/7:1.5:-3:-30:50:-:2026-11-25 10:00:00+00:-:mdd,win_rate 20/30:29.7:14.49:11189:65:1.3:2026-11-25 10:00:00+00:mdd,pnl,roi:-" \
  "$BEFORE"
assert_equal "after: only mdd and its attestations changed" \
  "10/7:-:-74.9:-749:40:0:2026-11-25 10:00:00+00:pnl,roi:- 10/30:-:38.6:28390:73.33:0:2026-11-25 10:00:00+00:pnl,roi:- 10/90:-:12.5:900:55:1.1:2026-11-24 09:00:00+00:pnl,roi:- 11/30:-:5:50:60:-:2026-11-25 10:00:00+00:-:- 12/7:-:-3:-30:50:-:2026-11-25 10:00:00+00:-:win_rate 20/30:29.7:14.49:11189:65:1.3:2026-11-25 10:00:00+00:mdd,pnl,roi:-" \
  "$(snapshot)"

assert_equal "after: a NULL board mdd keeps NULL and as_of advances" \
  "-|2026-11-25 12:00:00+00" \
  "$(psql_as postgres -Atqc "SET TIME ZONE 'UTC'; BEGIN; $BOARD_WRITE;
     SELECT coalesce(mdd::text, '-') || '|' || as_of FROM arena.trader_stats WHERE trader_id = 10 AND timeframe = 7;
     ROLLBACK;" | grep '|')"

AFTER="$(snapshot)"
psql_as postgres -q -f "$NEW_MIGRATION" 2>"$TMP_ROOT/replay.err" >/dev/null
grep -q 'gate_cfd mdd cleanup: cleared 0 rows, archived 0' "$TMP_ROOT/replay.err"
assert_equal "a replay changes no row" "$AFTER" "$(snapshot)"
assert_equal "a replay archives nothing" "4" \
  "$(psql_as postgres -Atqc "SELECT count(*) FROM arena.trader_stats_cleared_mdd")"

if psql_as postgres -q -c "UPDATE arena.trader_stats_cleared_mdd SET cleared_mdd = 1" 2>/dev/null; then
  echo "the archive accepted an UPDATE" >&2
  exit 1
fi
if psql_as postgres -q -c "DELETE FROM arena.trader_stats_cleared_mdd" 2>/dev/null; then
  echo "the archive accepted a DELETE" >&2
  exit 1
fi
echo "ok: the archive is append-only"
assert_equal "application roles cannot read the archive" "f:f:f" \
  "$(psql_as postgres -Atqc "
     SELECT has_table_privilege('anon', 'arena.trader_stats_cleared_mdd', 'SELECT') || ':' ||
            has_table_privilege('authenticated', 'arena.trader_stats_cleared_mdd', 'SELECT') || ':' ||
            has_table_privilege('service_role', 'arena.trader_stats_cleared_mdd', 'SELECT')" |
     sed 's/false/f/g; s/true/t/g')"

echo "clear gate_cfd unverified mdd PostgreSQL 17 proof passed"
