#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that only complete, current, registry-backed
# leaderboard rows receive a deterministic rank. This owns an isolated cluster
# and never connects to application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729223000_rerank_public_eligible_rows_only.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/rerank-public-eligible-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 4000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE rogue_executor NOLOGIN;
CREATE ROLE rogue_delegate NOLOGIN;
CREATE SCHEMA arena;

CREATE TABLE arena.exchanges (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  slug text PRIMARY KEY,
  exchange_id bigint NOT NULL REFERENCES arena.exchanges(id),
  seasons text[] NOT NULL
);

CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  score_completeness text,
  metrics_estimated boolean,
  is_outlier boolean,
  arena_score numeric,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  max_drawdown numeric,
  computed_at timestamptz,
  rank integer CHECK (rank IS NULL OR rank > 0),
  rank_change integer,
  is_new boolean,
  PRIMARY KEY (id, season_id)
);

ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_block_cumulative_bitget_bot_authority
  CHECK (
    source <> ALL (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
  );

INSERT INTO arena.exchanges (id, name) VALUES (1, 'Example');
INSERT INTO arena.sources (slug, exchange_id, seasons)
VALUES
  ('trusted_source', 1, ARRAY['7D', '30D', '90D']::text[]),
  ('bitget_bots_futures', 1, ARRAY['30D']::text[]),
  ('bitget_bots_spot', 1, ARRAY['30D']::text[]);

CREATE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_name text,
  season_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    source_row.slug,
    source_row.slug,
    exchange_row.name,
    declared.season_id
  FROM arena.sources AS source_row
  JOIN arena.exchanges AS exchange_row
    ON exchange_row.id = source_row.exchange_id
  CROSS JOIN LATERAL pg_catalog.unnest(source_row.seasons)
    AS declared(season_id)
  WHERE
    -- bitget-bot-cumulative-rank-quarantine@1
    source_row.slug <> ALL (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    );
$function$;

CREATE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    (p_rank).source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    AND (p_rank).source = pg_catalog.lower(pg_catalog.btrim((p_rank).source))
    AND pg_catalog.btrim((p_rank).source_trader_id) <> ''
    AND (p_rank).source_trader_id = pg_catalog.btrim((p_rank).source_trader_id)
    AND (p_rank).score_completeness IS NOT DISTINCT FROM 'full'
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score IS NOT NULL
    AND (p_rank).arena_score > 0
    AND (p_rank).arena_score <= 100
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).roi BETWEEN -10000 AND 10000
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).pnl BETWEEN -100000000 AND 1000000000
    AND (p_rank).win_rate IS NOT NULL
    AND (p_rank).win_rate BETWEEN 0 AND 100
    AND (p_rank).max_drawdown IS NOT NULL
    AND (p_rank).max_drawdown >= 0
    AND (p_rank).max_drawdown < 100
    AND (p_rank).computed_at IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours'
    AND (p_rank).computed_at <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

-- A new public function inherits this rogue grant. The legacy function also
-- receives a direct grant-option chain, proving the migration closes both
-- CREATE-time default ACLs and CREATE OR REPLACE-preserved historical ACLs.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO rogue_executor;

CREATE FUNCTION public.rerank_leaderboard(p_season_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN 0;
END
$function$;

GRANT EXECUTE ON FUNCTION public.rerank_leaderboard(text)
  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rerank_leaderboard(text)
  TO rogue_executor WITH GRANT OPTION;
SET ROLE rogue_executor;
GRANT EXECUTE ON FUNCTION public.rerank_leaderboard(text)
  TO rogue_delegate;
RESET ROLE;

-- Seed the bad state produced by the deployed legacy reranker. This migration
-- installs authority only; the following count-authority migration owns the
-- all-season live repair in the same transaction as its derived counts.
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_trader_id, score_completeness,
  metrics_estimated, is_outlier, arena_score, roi, pnl, win_rate,
  max_drawdown, computed_at, rank
) VALUES
  (1, '7D', 'trusted_source', 'eligible-high', 'full', false, false, 90, 20, 1000, 60, 10, pg_catalog.now(), 90),
  (2, '7D', 'trusted_source', 'eligible-tie-a', 'full', false, false, 80, 20, 1000, 60, 10, pg_catalog.now(), 80),
  (3, '7D', 'trusted_source', 'eligible-tie-b', 'full', false, false, 80, 20, 1000, 60, 10, pg_catalog.now(), 70),
  (4, '7D', 'trusted_source', 'zero-score', 'full', false, false, 0, 20, 1000, 60, 10, pg_catalog.now(), 4),
  (5, '7D', 'trusted_source', 'negative-score', 'full', false, false, -1, 20, 1000, 60, 10, pg_catalog.now(), 5),
  (6, '7D', 'trusted_source', 'null-score', 'full', false, false, NULL, 20, 1000, 60, 10, pg_catalog.now(), 6),
  (7, '7D', 'trusted_source', 'outlier', 'full', false, true, 99, 20, 1000, 60, 10, pg_catalog.now(), 7),
  (8, '7D', 'trusted_source', 'partial', 'partial', false, false, 98, 20, 1000, 60, 10, pg_catalog.now(), 8),
  (9, '7D', 'trusted_source', 'estimated', 'full', true, false, 97, 20, 1000, 60, 10, pg_catalog.now(), 9),
  (10, '7D', 'trusted_source', 'missing-win-rate', 'full', false, false, 96, 20, 1000, NULL, 10, pg_catalog.now(), 10),
  (11, '7D', 'trusted_source', 'stale', 'full', false, false, 95, 20, 1000, 60, 10, pg_catalog.now() - interval '49 hours', 11),
  (12, '7D', 'trusted_source', 'future', 'full', false, false, 94, 20, 1000, 60, 10, pg_catalog.now() + interval '10 minutes', 12),
  (13, '7D', 'outside_registry', 'outside', 'full', false, false, 93, 20, 1000, 60, 10, pg_catalog.now(), 13),
  (14, '7D', 'trusted_source', 'mdd-sentinel', 'full', false, false, 92, 20, 1000, 60, 100, pg_catalog.now(), 14),
  (15, '7D', 'trusted_source', 'score-over-100', 'full', false, false, 101, 20, 1000, 60, 10, pg_catalog.now(), 15),
  (1, '30D', 'trusted_source', 'other-season', 'full', false, false, 70, 20, 1000, 60, 10, pg_catalog.now(), 77);

UPDATE public.leaderboard_ranks
SET rank_change = 42, is_new = true;
SQL

psql_db -q -f "$MIGRATION"

UNCHANGED="$(psql_db -Atqc "
  SELECT
    pg_catalog.count(*) FILTER (WHERE season_id = '7D' AND rank IS NOT NULL) || '|' ||
    pg_catalog.max(rank) FILTER (WHERE season_id = '7D') || '|' ||
    pg_catalog.max(rank) FILTER (WHERE season_id = '30D')
  FROM public.leaderboard_ranks;
")"
assert_equal "function install performs no split-transaction repair" "15|90|77" "$UNCHANGED"

UPDATED="$(psql_db -Atqc "SELECT public.rerank_public_eligible_leaderboard('7D');")"
assert_equal "explicit eligibility rerank changed-row count" "15" "$UPDATED"

RESULT="$(psql_db -Atqc "
  SELECT
    pg_catalog.count(*) FILTER (WHERE season_id = '7D' AND rank IS NOT NULL) || '|' ||
    pg_catalog.min(rank) FILTER (WHERE season_id = '7D') || '|' ||
    pg_catalog.max(rank) FILTER (WHERE season_id = '7D') || '|' ||
    pg_catalog.count(DISTINCT rank) FILTER (WHERE season_id = '7D') || '|' ||
    pg_catalog.count(*) FILTER (WHERE season_id = '7D' AND id > 3 AND rank IS NOT NULL) || '|' ||
    pg_catalog.max(rank) FILTER (WHERE season_id = '7D' AND id = 2) || '|' ||
    pg_catalog.max(rank) FILTER (WHERE season_id = '7D' AND id = 3) || '|' ||
    pg_catalog.max(rank) FILTER (WHERE season_id = '30D' AND id = 1) || '|' ||
    pg_catalog.count(rank_change) FILTER (WHERE season_id = '7D') || '|' ||
    pg_catalog.bool_or(is_new) FILTER (WHERE season_id = '7D')
  FROM public.leaderboard_ranks;")"
assert_equal "explicit rerank withholds unversioned movement" "3|1|3|3|0|2|3|77|0|false" "$RESULT"

UPDATED="$(psql_db -Atqc "SELECT public.rerank_public_eligible_leaderboard('7D');")"
assert_equal "stable rerank replay" "0" "$UPDATED"

psql_db -q -c "
  UPDATE public.leaderboard_ranks
  SET score_completeness = 'partial'
  WHERE id = 1 AND season_id = '7D';"

UPDATED="$(psql_db -Atqc "SELECT public.rerank_public_eligible_leaderboard('7D');")"
assert_equal "eligibility-loss changed-row count" "3" "$UPDATED"

RESULT="$(psql_db -Atqc "
  SELECT
    rank IS NULL || '|' ||
    (SELECT rank FROM public.leaderboard_ranks WHERE id = 2 AND season_id = '7D') || '|' ||
    (SELECT rank FROM public.leaderboard_ranks WHERE id = 3 AND season_id = '7D') || '|' ||
    ((SELECT rank_change FROM public.leaderboard_ranks WHERE id = 2 AND season_id = '7D') IS NULL) || '|' ||
    ((SELECT rank_change FROM public.leaderboard_ranks WHERE id = 3 AND season_id = '7D') IS NULL)
  FROM public.leaderboard_ranks
  WHERE id = 1 AND season_id = '7D';")"
assert_equal "rank compaction with unknown movement" "true|1|2|true|true" "$RESULT"

UPDATED="$(psql_db -Atqc "SELECT public.rerank_public_eligible_leaderboard('7D');")"
assert_equal "stable compaction replay" "0" "$UPDATED"

UPDATED="$(psql_db -Atqc "SELECT public.rerank_leaderboard('7D');")"
assert_equal "legacy RPC remains untouched before rank-count cutover" "0" "$UPDATED"

psql_db -q <<'SQL'
DO $invalid_season$
BEGIN
  BEGIN
    PERFORM public.rerank_public_eligible_leaderboard('365D');
    RAISE EXCEPTION 'invalid season unexpectedly succeeded';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$invalid_season$;
SQL

PRIVILEGES="$(psql_db -Atqc "
  SELECT
    pg_catalog.has_function_privilege('service_role', 'public.rerank_public_eligible_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('anon', 'public.rerank_public_eligible_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('authenticated', 'public.rerank_public_eligible_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('service_role', 'public.rerank_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('anon', 'public.rerank_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('authenticated', 'public.rerank_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('rogue_executor', 'public.rerank_public_eligible_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('rogue_executor', 'public.rerank_leaderboard(text)', 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('rogue_delegate', 'public.rerank_leaderboard(text)', 'EXECUTE');")"
assert_equal "new RPC is service-only while legacy ACL remains untouched" "true|false|false|true|true|true|false|true|true" "$PRIVILEGES"

UNEXPECTED_EXECUTE_ACLS="$(psql_db -Atqc "
  SELECT pg_catalog.count(*)
  FROM pg_catalog.pg_proc AS function_row
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      function_row.proacl,
      pg_catalog.acldefault('f', function_row.proowner)
    )
  ) AS acl_row
  WHERE function_row.oid = ANY (
    ARRAY[
      'public.rerank_public_eligible_leaderboard(text)'::pg_catalog.regprocedure::oid
    ]
  )
    AND acl_row.privilege_type = 'EXECUTE'
    AND acl_row.grantee <> function_row.proowner
    AND acl_row.grantee <> 'service_role'::pg_catalog.regrole;")"
assert_equal "new RPC has no non-owner/non-service execute ACLs" "0" "$UNEXPECTED_EXECUTE_ACLS"

SERVICE_EXECUTE_ACLS="$(psql_db -Atqc "
  SELECT pg_catalog.count(*)
  FROM pg_catalog.pg_proc AS function_row
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      function_row.proacl,
      pg_catalog.acldefault('f', function_row.proowner)
    )
  ) AS acl_row
  WHERE function_row.oid = ANY (
    ARRAY[
      'public.rerank_public_eligible_leaderboard(text)'::pg_catalog.regprocedure::oid
    ]
  )
    AND acl_row.privilege_type = 'EXECUTE'
    AND acl_row.grantee = 'service_role'::pg_catalog.regrole
    AND NOT acl_row.is_grantable;")"
assert_equal "exact new-RPC service execute ACL" "1" "$SERVICE_EXECUTE_ACLS"

CONTRACT="$(psql_db -Atqc "
  SELECT
    (function_row.proowner = 'postgres'::pg_catalog.regrole) || '|' ||
    function_row.prosecdef || '|' ||
    (function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=10s'
    ]::text[])
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = 'public.rerank_public_eligible_leaderboard(text)'::pg_catalog.regprocedure;")"
assert_equal "hardened function contract" "true|true|true" "$CONTRACT"

echo "eligibility-aware leaderboard rerank PostgreSQL 17 proof passed"
