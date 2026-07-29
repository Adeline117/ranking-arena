#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for the partitioned leaderboard max-drawdown
# sign repair and canonical positive-magnitude CHECK.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FOUNDATION="$ROOT_DIR/supabase/migrations/__tests__/fixtures/leaderboard-rank-atomic-writer-foundation.pg17.inc"
MUTATION_MIGRATION="$ROOT_DIR/supabase/migrations/20260724235000_leaderboard_publication_mutation_fence.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260725017250_normalize_leaderboard_rank_max_drawdown.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/rank-mdd-positive-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 4000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -240 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_migration_failure() {
  local label="$1"
  local pattern="$2"
  if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,240p' "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_sql_failure() {
  local label="$1"
  local sql="$2"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q 'leaderboard_ranks_max_drawdown_positive_check' "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,160p' "$ERROR_FILE" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE fixture_rogue NOLOGIN;
CREATE SCHEMA arena;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
SQL
psql_cmd -q -f "$FOUNDATION"
psql_cmd -q -f "$MUTATION_MIGRATION"

# Unknown constraints are never guessed away, and bad stored values are never
# silently clamped merely to make validation pass.
psql_cmd -q <<'SQL'
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT fixture_unknown_mdd_check
  CHECK (max_drawdown IS NULL OR max_drawdown <= 100);
SQL
expect_migration_failure \
  'max-drawdown migration guessed at an unknown constraint' \
  'unexpected or drifted leaderboard max-drawdown constraint requires audit'
psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks DROP CONSTRAINT fixture_unknown_mdd_check'

psql_cmd -q <<'SQL'
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_max_drawdown_check
  CHECK (max_drawdown IS NULL OR max_drawdown >= -50);
SQL
expect_migration_failure \
  'max-drawdown migration deleted a same-name drifted constraint' \
  'unexpected or drifted leaderboard max-drawdown constraint requires audit'
psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks DROP CONSTRAINT leaderboard_ranks_max_drawdown_check'

psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  season_id, source, source_trader_id, max_drawdown
) VALUES
  ('7D', 'alpha', 'impossible', 100.01),
  ('7D', 'alpha', 'not_a_number', 'NaN'::numeric);
SQL
expect_migration_failure \
  'max-drawdown migration clamped impossible stored values' \
  'leaderboard max-drawdown contains non-finite or out-of-range values'
psql_cmd -q -c \
  "DELETE FROM public.leaderboard_ranks WHERE source_trader_id IN ('impossible','not_a_number')"

# Reproduce the post-partition defect: the renamed parent retained the obsolete
# negative-sign CHECK and therefore contains negative magnitudes.
psql_cmd -q <<'SQL'
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_partitioned_max_drawdown_check
  CHECK (
    max_drawdown IS NULL
    OR (max_drawdown >= -100 AND max_drawdown <= 0)
  );

INSERT INTO public.leaderboard_ranks (
  season_id, source, source_trader_id, max_drawdown
) VALUES
  ('7D', 'alpha', 'negative', -12.34),
  ('30D', 'alpha', 'zero', 0),
  ('90D', 'beta', 'unknown', NULL),
  ('90D', 'beta', 'total_loss', -100);

CREATE TABLE arena.fixture_mdd_fence_before AS
SELECT season_id, source, mutation_seq
FROM arena.leaderboard_rank_mutation_fences
WHERE (season_id, source) IN (('7D', 'alpha'), ('90D', 'beta'));
SQL

psql_cmd -q -f "$MIGRATION"

NORMALIZED_STATE="$(psql_cmd -Atqc "
  SELECT pg_catalog.string_agg(
    season_id || ':' || source || ':' || source_trader_id || ':' ||
      COALESCE(max_drawdown::text, 'null'),
    E'\\n' ORDER BY season_id, source, source_trader_id
  )
  FROM public.leaderboard_ranks;
")"
if [[ "$NORMALIZED_STATE" != $'30D:alpha:zero:0.00\n7D:alpha:negative:12.34\n90D:beta:total_loss:100.00\n90D:beta:unknown:null' ]]; then
  echo "legacy drawdown magnitudes were not normalized exactly" >&2
  printf '%s\n' "$NORMALIZED_STATE" >&2
  exit 1
fi

if [[ "$(psql_cmd -Atqc "
  SELECT pg_catalog.count(*)::text || '|' ||
    pg_catalog.bool_and(
      fence.mutation_seq = before_fence.mutation_seq + 1
    )::text
  FROM arena.fixture_mdd_fence_before AS before_fence
  JOIN arena.leaderboard_rank_mutation_fences AS fence
    USING (season_id, source);
")" != '2|true' ]]; then
  echo 'drawdown normalization did not advance exact source mutation fences' >&2
  exit 1
fi

CONSTRAINT_STATE="$(psql_cmd -Atqc "
  SELECT constraint_row.convalidated::text || '|' ||
    pg_catalog.pg_get_expr(
      constraint_row.conbin,
      constraint_row.conrelid,
      false
    ) || '|' ||
    pg_catalog.obj_description(constraint_row.oid, 'pg_constraint')
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'public.leaderboard_ranks'::regclass
    AND constraint_row.conname =
        'leaderboard_ranks_max_drawdown_positive_check';
")"
if [[ "$CONSTRAINT_STATE" != 'true|((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))|Observed max-drawdown magnitude in positive percentage form [0,100]. Public rank eligibility is narrower and rejects 100.' ]]; then
  echo "canonical max-drawdown constraint is not exact" >&2
  printf '%s\n' "$CONSTRAINT_STATE" >&2
  exit 1
fi

expect_sql_failure \
  'canonical max-drawdown constraint accepted a negative value' \
  "INSERT INTO public.leaderboard_ranks (season_id,source,source_trader_id,max_drawdown) VALUES ('7D','alpha','bad_negative',-0.01)"
expect_sql_failure \
  'canonical max-drawdown constraint accepted a value over 100' \
  "INSERT INTO public.leaderboard_ranks (season_id,source,source_trader_id,max_drawdown) VALUES ('7D','alpha','bad_high',100.01)"

# Reapply must be a strict data/object no-op: no rewritten row, new sequence
# value, replacement constraint, or physical tuple is permitted.
STATE_BEFORE="$(psql_cmd -Atqc "
  SELECT
    (SELECT oid::text FROM pg_catalog.pg_constraint
      WHERE conrelid='public.leaderboard_ranks'::regclass
        AND conname='leaderboard_ranks_max_drawdown_positive_check') || '|' ||
    (SELECT pg_catalog.string_agg(
       tableoid::text || ':' || xmin::text || ':' || ctid::text || ':' ||
         pg_catalog.to_jsonb(rank_row)::text,
       E'\\n' ORDER BY season_id, source, source_trader_id
     ) FROM public.leaderboard_ranks AS rank_row) || '|' ||
    (SELECT last_value::text || ':' || is_called::text
     FROM public.leaderboard_ranks_id_seq) || '|' ||
    (SELECT pg_catalog.string_agg(
       season_id || ':' || source || ':' || mutation_seq::text,
       E'\\n' ORDER BY season_id, source
     ) FROM arena.leaderboard_rank_mutation_fences);
")"
psql_cmd -q -f "$MIGRATION"
STATE_AFTER="$(psql_cmd -Atqc "
  SELECT
    (SELECT oid::text FROM pg_catalog.pg_constraint
      WHERE conrelid='public.leaderboard_ranks'::regclass
        AND conname='leaderboard_ranks_max_drawdown_positive_check') || '|' ||
    (SELECT pg_catalog.string_agg(
       tableoid::text || ':' || xmin::text || ':' || ctid::text || ':' ||
         pg_catalog.to_jsonb(rank_row)::text,
       E'\\n' ORDER BY season_id, source, source_trader_id
     ) FROM public.leaderboard_ranks AS rank_row) || '|' ||
    (SELECT last_value::text || ':' || is_called::text
     FROM public.leaderboard_ranks_id_seq) || '|' ||
    (SELECT pg_catalog.string_agg(
       season_id || ':' || source || ':' || mutation_seq::text,
       E'\\n' ORDER BY season_id, source
     ) FROM arena.leaderboard_rank_mutation_fences);
")"
if [[ "$STATE_BEFORE" != "$STATE_AFTER" ]]; then
  echo 'max-drawdown migration replay changed constraint, rows, or sequence' >&2
  exit 1
fi

# Replay is an attestation, not a repair path.
psql_cmd -q <<'SQL'
ALTER TABLE public.lr_7d
  ADD CONSTRAINT fixture_extra_child_mdd_check
  CHECK (max_drawdown IS NULL OR max_drawdown >= 0);
SQL
expect_migration_failure \
  'max-drawdown replay accepted a child-only constraint' \
  'leaderboard max-drawdown normalization postcondition failed'
if ! psql_cmd -Atqc "
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.lr_7d'::regclass
      AND conname='fixture_extra_child_mdd_check'
  );
" | rg -q '^t$'; then
  echo 'max-drawdown replay silently repaired a child-only constraint' >&2
  exit 1
fi
psql_cmd -q -c \
  'ALTER TABLE public.lr_7d DROP CONSTRAINT fixture_extra_child_mdd_check'

psql_cmd -q <<'SQL'
ALTER TABLE public.leaderboard_ranks
  DROP CONSTRAINT leaderboard_ranks_max_drawdown_positive_check;
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_max_drawdown_positive_check
  CHECK (max_drawdown IS NULL OR max_drawdown >= 0);
SQL
expect_migration_failure \
  'max-drawdown replay accepted a weakened canonical constraint' \
  'canonical leaderboard max-drawdown constraint drifted'

echo 'leaderboard rank max-drawdown normalization PG17 proof passed'
