#!/usr/bin/env bash

# PostgreSQL 17 behavior proof for the public ranked cohort view. It owns an
# isolated cluster and never connects to application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260816151614_public_ranked_leaderboard.sql"
SOURCE_FRESHNESS_MIGRATION="$ROOT_DIR/supabase/migrations/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi
if [[ ! -f "$SOURCE_FRESHNESS_MIGRATION" ]]; then
  echo "Required source freshness migration not found: $SOURCE_FRESHNESS_MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/public-ranked-leaderboard-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
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
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_reader NOLOGIN NOBYPASSRLS;

CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, rogue_reader;

CREATE TABLE arena.exchanges (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  slug text PRIMARY KEY,
  exchange_id bigint NOT NULL REFERENCES arena.exchanges(id),
  status text NOT NULL,
  serving_mode text NOT NULL,
  seasons text[] NOT NULL
);

CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL,
  source_type text,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric,
  arena_score_v3 numeric,
  arena_score_v4 numeric,
  score_factors jsonb,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  max_drawdown numeric,
  followers integer,
  copiers integer,
  trades_count integer,
  handle text,
  avatar_url text,
  computed_at timestamptz,
  profitability_score numeric,
  risk_control_score numeric,
  execution_score numeric,
  score_completeness text,
  trading_style text,
  avg_holding_hours numeric,
  style_confidence numeric,
  sharpe_ratio numeric,
  sortino_ratio numeric,
  profit_factor numeric,
  calmar_ratio numeric,
  trader_type text,
  is_outlier boolean,
  metrics_estimated boolean,
  rank_change integer,
  is_new boolean,
  PRIMARY KEY (id, season_id)
) PARTITION BY LIST (season_id);

CREATE TABLE public.leaderboard_ranks_7d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.leaderboard_ranks_30d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.leaderboard_ranks_default
  PARTITION OF public.leaderboard_ranks DEFAULT;

ALTER TABLE public.leaderboard_ranks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.leaderboard_ranks,
  public.leaderboard_ranks_7d,
  public.leaderboard_ranks_30d,
  public.leaderboard_ranks_default
  FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
GRANT SELECT ON TABLE public.leaderboard_ranks,
  public.leaderboard_ranks_7d,
  public.leaderboard_ranks_30d,
  public.leaderboard_ranks_default TO anon, authenticated, service_role;

INSERT INTO arena.exchanges (id, name) VALUES (1, 'Fixture Exchange');
INSERT INTO arena.sources (slug, exchange_id, status, serving_mode, seasons)
VALUES
  ('active_source', 1, 'active', 'serving', ARRAY['7D']::text[]),
  ('inactive_source', 1, 'inactive', 'serving', ARRAY['7D']::text[]),
  ('quarantined_like', 1, 'active', 'serving', ARRAY['7D']::text[]);

-- This is the fixture equivalent of the migration-owned source authority:
-- an active serving source can still be excluded by a quarantine rule.
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
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND source_row.slug <> 'quarantined_like';
$function$;

ALTER FUNCTION public.arena_freshness_expected_sources() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_freshness_expected_sources()
  FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
GRANT EXECUTE ON FUNCTION public.arena_freshness_expected_sources()
  TO service_role;

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
    (p_rank).score_completeness IS NOT DISTINCT FROM 'full'
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score IS NOT NULL
    AND (p_rank).arena_score > 0
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).win_rate IS NOT NULL
    AND (p_rank).max_drawdown IS NOT NULL
    AND (p_rank).computed_at IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours'
    AND (p_rank).computed_at <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
SQL

psql_db -q -f "$MIGRATION"

VIEW_ACL="$(psql_db -Atqc "
  SELECT
    relation.relowner::pg_catalog.regrole::text || '|' ||
    (relation.reloptions @> ARRAY[
      'security_barrier=true', 'security_invoker=false'
    ]::text[]) || '|' ||
    pg_catalog.has_table_privilege(
      'anon', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'authenticated', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'service_role', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'rogue_reader', 'public.public_ranked_leaderboard', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'anon', 'public.public_ranked_leaderboard', 'INSERT'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon', 'public.arena_freshness_expected_sources()', 'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_source_is_expected(text,text)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    )
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.public_ranked_leaderboard'::pg_catalog.regclass;")"
assert_equal "public ranked cohort view owner/options/ACL" \
  "postgres|true|true|true|true|false|false|false|true|false|true" "$VIEW_ACL"

WRAPPER_CONTRACT="$(psql_db -Atqc "
  SELECT
    function_row.proowner::pg_catalog.regrole::text || '|' ||
    pg_catalog.format_type(function_row.prorettype, NULL) || '|' ||
    function_row.proretset || '|' ||
    (function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp', 'row_security=off'
    ]::text[]) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_source_is_expected(text,text)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'rogue_reader',
      'arena.public_ranked_leaderboard_source_is_expected(text,text)',
      'EXECUTE'
    )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = pg_catalog.to_regprocedure(
    'arena.public_ranked_leaderboard_source_is_expected(text,text)'
  );")"
assert_equal "pair-scoped source wrapper owner/type/config/ACL" \
  "postgres|boolean|false|true|true|false" "$WRAPPER_CONTRACT"

ROW_WRAPPER_CONTRACT="$(psql_db -Atqc "
  SELECT
    function_row.proowner::pg_catalog.regrole::text || '|' ||
    pg_catalog.format_type(function_row.prorettype, NULL) || '|' ||
    function_row.proretset || '|' ||
    (function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp', 'row_security=off'
    ]::text[]) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'rogue_reader',
      'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)',
      'EXECUTE'
    )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = pg_catalog.to_regprocedure(
    'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)'
  );")"
assert_equal "row eligibility wrapper owner/type/config/ACL" \
  "postgres|boolean|false|true|true|false" "$ROW_WRAPPER_CONTRACT"

VIEW_PRIVATE_COLUMN_COUNT="$(psql_db -Atqc "
  SELECT pg_catalog.count(*)
  FROM information_schema.columns AS column_row
  WHERE column_row.table_schema = 'public'
    AND column_row.table_name = 'public_ranked_leaderboard'
    AND column_row.column_name = 'score_factors';")"
assert_equal "public view omits internal score factors" "0" "$VIEW_PRIVATE_COLUMN_COUNT"

psql_db -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_type, source_trader_id, rank,
  arena_score, arena_score_v3, arena_score_v4, score_factors,
  roi, pnl, win_rate, max_drawdown, followers, copiers, trades_count,
  handle, avatar_url, computed_at, profitability_score, risk_control_score,
  execution_score, score_completeness, trading_style, avg_holding_hours,
  style_confidence, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio,
  trader_type, is_outlier, metrics_estimated, rank_change, is_new
)
VALUES
  (1, '7D', 'active_source', 'futures', 'eligible_one', 1,
   90, 89, 90, '{"roi":0.5}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Eligible One', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (2, '7D', 'active_source', 'futures', 'partial', 2,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Partial', NULL, statement_timestamp(), 90, 80,
   70, 'partial', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (3, '7D', 'active_source', 'futures', 'estimated', 3,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Estimated', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, true, 0, false),
  (4, '7D', 'active_source', 'futures', 'null_metric', 4,
   90, 89, 90, '{}'::jsonb,
   NULL, 1000, 60, 10, 100, 20, 30,
   'Null Metric', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (5, '7D', 'active_source', 'futures', 'stale', 5,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Stale', NULL, statement_timestamp() - interval '49 hours', 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (6, '7D', 'active_source', 'futures', 'unranked', NULL,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Unranked', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (7, '7D', 'inactive_source', 'futures', 'inactive', 7,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Inactive', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (8, '7D', 'quarantined_like', 'futures', 'quarantined', 8,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Quarantined', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (9, '30D', 'active_source', 'futures', 'wrong_season', 9,
   90, 89, 90, '{}'::jsonb,
   12, 1000, 60, 10, 100, 20, 30,
   'Wrong Season', NULL, statement_timestamp(), 90, 80,
   70, 'full', 'swing', 12, 0.8, 2, 3, 1.5, 1.2,
   'human', false, false, 0, false),
  (10, '7D', 'active_source', 'futures', 'eligible_two', 10,
   89, 88, 89, '{}'::jsonb,
   11, 900, 59, 11, 99, 19, 29,
   'Eligible Two', NULL, statement_timestamp(), 89, 79,
   69, 'full', 'swing', 11, 0.7, 1.9, 2.9, 1.4, 1.1,
   'human', false, false, 0, false);
SQL

VISIBLE_ROWS="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT COALESCE(
    pg_catalog.string_agg(source_trader_id, ',' ORDER BY rank),
    ''
  )
  FROM public.public_ranked_leaderboard;")"
assert_equal "only full/current/ranked/expected rows are public" \
  "eligible_one,eligible_two" "$VISIBLE_ROWS"

WRAPPER_BEHAVIOR="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'active_source', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'inactive_source', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'quarantined_like', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        'active_source', '30D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        ' Active_Source ', '7D'
      )::text,
      'NULL'
    ) || '|' ||
    COALESCE(
      arena.public_ranked_leaderboard_source_is_expected(
        NULL, '7D'
      )::text,
      'NULL'
    );")"
assert_equal "wrapper only answers exact source-season membership" \
  "true|false|false|false|false|NULL" "$WRAPPER_BEHAVIOR"

OFFSET_ROW="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT source_trader_id
  FROM public.public_ranked_leaderboard
  ORDER BY rank
  OFFSET 1 LIMIT 1;")"
assert_equal "view filters unsafe rows before caller OFFSET" "eligible_two" "$OFFSET_ROW"

set +e
psql_db -q >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE anon;
SELECT * FROM public.arena_freshness_expected_sources();
SQL
DIRECT_AUTHORITY_STATUS=$?
set -e
if ((DIRECT_AUTHORITY_STATUS == 0)); then
  echo "anon unexpectedly executed the private expected-source authority" >&2
  exit 1
fi
rg -q 'permission denied for function arena_freshness_expected_sources' "$ERROR_FILE" || {
  echo "source authority denial failed for an unexpected reason" >&2
  sed -n '1,100p' "$ERROR_FILE" >&2
  exit 1
}

set +e
psql_db -q >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE anon;
SELECT arena.leaderboard_rank_row_is_public_eligible(
  NULL::public.leaderboard_ranks,
  statement_timestamp()
);
SQL
DIRECT_ELIGIBILITY_STATUS=$?
set -e
if ((DIRECT_ELIGIBILITY_STATUS == 0)); then
  echo "anon unexpectedly executed the private row eligibility authority" >&2
  exit 1
fi
rg -q 'permission denied for function leaderboard_rank_row_is_public_eligible' "$ERROR_FILE" || {
  echo "row eligibility denial failed for an unexpected reason" >&2
  sed -n '1,100p' "$ERROR_FILE" >&2
  exit 1
}


# ---------------------------------------------------------------------------
# Constant-time sealed serving authority successor. This fixture exposes the
# same protocol edge as the real full seal: immutable receipt -> local cohort
# marker -> all-source freshness UPSERT. The migration must capture only that
# same transaction and public reads must not call the full proof.
# ---------------------------------------------------------------------------

psql_db -q <<'SQL'
ALTER ROLE service_role BYPASSRLS;

ALTER TABLE public.leaderboard_ranks
  ADD COLUMN rank_publication_id uuid;

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL,
  source text NOT NULL,
  source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  score_cohort_id uuid,
  rank_mutation_seq bigint,
  published_rank_count integer,
  published_identity_sha256 text,
  PRIMARY KEY (season_id, source)
);
ALTER TABLE public.leaderboard_source_freshness ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leaderboard_source_freshness_public_read"
  ON public.leaderboard_source_freshness FOR SELECT USING (true);
GRANT SELECT ON public.leaderboard_source_freshness TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.leaderboard_source_freshness TO service_role;

CREATE TABLE arena.leaderboard_rank_mutation_fences (
  season_id text NOT NULL,
  source text NOT NULL,
  mutation_seq bigint NOT NULL,
  PRIMARY KEY (season_id, source)
);

CREATE TABLE arena.leaderboard_rank_publications (
  id uuid PRIMARY KEY,
  season_id text NOT NULL,
  request_sha256 text NOT NULL,
  source_count integer NOT NULL,
  trader_count integer NOT NULL,
  proofs jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  UNIQUE (id, season_id)
);
ALTER TABLE arena.leaderboard_rank_publications ENABLE ROW LEVEL SECURITY;

-- Fixture receipts mirror the production immutable publication contract.

CREATE FUNCTION arena.reject_leaderboard_rank_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fixture_function$
BEGIN
  RAISE EXCEPTION 'leaderboard publication receipts are immutable'
    USING ERRCODE = '55000';
END;
$fixture_function$;
ALTER FUNCTION arena.reject_leaderboard_rank_publication_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_rank_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
CREATE TRIGGER leaderboard_rank_publication_immutable
BEFORE UPDATE OR DELETE ON arena.leaderboard_rank_publications
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

UPDATE arena.sources SET status = 'inactive' WHERE slug = 'active_source';
INSERT INTO arena.sources (slug, exchange_id, status, serving_mode, seasons)
VALUES
  ('seal_alpha', 1, 'active', 'serving', ARRAY['30D']::text[]),
  ('seal_beta', 1, 'active', 'serving', ARRAY['30D']::text[]),
  ('stale_exact', 1, 'active', 'serving', ARRAY['7D']::text[]),
  ('lease_source', 1, 'active', 'serving', ARRAY['90D']::text[]);

CREATE FUNCTION public.arena_leaderboard_publication_proofs(
  p_season_id text,
  p_sources text[]
)
RETURNS TABLE (
  season_id text,
  source text,
  source_as_of timestamptz,
  recorded_at timestamptz,
  score_cohort_id uuid,
  rank_mutation_seq bigint,
  current_mutation_seq bigint,
  published_rank_count integer,
  published_identity_sha256 text,
  is_sealed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_season_id, requested.source, freshness.source_as_of,
    freshness.recorded_at, freshness.score_cohort_id,
    freshness.rank_mutation_seq, COALESCE(fence.mutation_seq, 0),
    freshness.published_rank_count, freshness.published_identity_sha256, false
  FROM pg_catalog.unnest(p_sources) AS requested(source)
  LEFT JOIN public.leaderboard_source_freshness AS freshness
    ON freshness.season_id = p_season_id AND freshness.source = requested.source
  LEFT JOIN arena.leaderboard_rank_mutation_fences AS fence
    ON fence.season_id = p_season_id AND fence.source = requested.source;
$function$;
ALTER FUNCTION public.arena_leaderboard_publication_proofs(text, text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
GRANT EXECUTE ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  TO service_role;

CREATE FUNCTION public.seal_leaderboard_rank_publication(
  p_season_id text,
  p_score_cohort_id uuid,
  p_source_publications jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_expected text[];
  v_count integer;
  v_published_at timestamptz := pg_catalog.statement_timestamp();
  v_proofs jsonb;
BEGIN
  SELECT pg_catalog.array_agg(authority.source ORDER BY authority.source COLLATE "C")
  INTO v_expected
  FROM (
    SELECT DISTINCT expected.filter_source COLLATE "C" AS source
    FROM public.arena_freshness_expected_sources() AS expected
    WHERE expected.season_id = p_season_id
  ) AS authority;
  v_count := pg_catalog.cardinality(v_expected);

  IF p_score_cohort_id IS NULL
     OR v_count NOT BETWEEN 1 AND 256
     OR p_source_publications IS NULL
     OR pg_catalog.jsonb_typeof(p_source_publications) <> 'array'
     OR pg_catalog.jsonb_array_length(p_source_publications) IS DISTINCT FROM v_count
     OR EXISTS (
       SELECT authority.source FROM pg_catalog.unnest(v_expected) AS authority(source)
       EXCEPT
       SELECT item.value->>'source'
       FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
     )
     OR EXISTS (
       SELECT item.value->>'source'
       FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
       EXCEPT
       SELECT pg_catalog.unnest(v_expected)
     )
     OR EXISTS (
       SELECT 1
       FROM public.leaderboard_ranks AS rank_row
       JOIN pg_catalog.unnest(v_expected) AS authority(source)
         ON authority.source = rank_row.source
       WHERE rank_row.season_id = p_season_id
         AND rank_row.rank_publication_id IS DISTINCT FROM p_score_cohort_id
     ) THEN
    RAISE EXCEPTION 'fixture full seal validation failed' USING ERRCODE = '23514';
  END IF;

  INSERT INTO arena.leaderboard_rank_mutation_fences (season_id, source, mutation_seq)
  SELECT p_season_id, authority.source, 0
  FROM pg_catalog.unnest(v_expected) AS authority(source)
  ON CONFLICT (season_id, source) DO NOTHING;

  WITH requested AS (
    SELECT item.value->>'source' AS source,
      (item.value->>'source_as_of')::timestamptz AS source_as_of
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
  ),
  proof_rows AS (
    SELECT requested.source, requested.source_as_of, fence.mutation_seq,
      (SELECT pg_catalog.count(*)::integer
       FROM public.leaderboard_ranks AS rank_row
       WHERE rank_row.season_id = p_season_id
         AND rank_row.source = requested.source) AS published_rank_count
    FROM requested
    JOIN arena.leaderboard_rank_mutation_fences AS fence
      ON fence.season_id = p_season_id AND fence.source = requested.source
  )
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'source', proof.source,
      'source_as_of', pg_catalog.to_char(
        proof.source_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'recorded_at', pg_catalog.to_char(
        v_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'score_cohort_id', p_score_cohort_id,
      'rank_mutation_seq', proof.mutation_seq,
      'published_rank_count', proof.published_rank_count,
      'published_identity_sha256', repeat('a', 64)
    )
    ORDER BY proof.source COLLATE "C"
  )
  INTO STRICT v_proofs
  FROM proof_rows AS proof;

  INSERT INTO arena.leaderboard_rank_publications (
    id, season_id, request_sha256, source_count, trader_count, proofs, published_at
  )
  SELECT p_score_cohort_id, p_season_id, repeat('a', 64), v_count,
    pg_catalog.count(*)::integer, v_proofs, v_published_at
  FROM public.leaderboard_ranks AS rank_row
  JOIN pg_catalog.unnest(v_expected) AS authority(source)
    ON authority.source = rank_row.source
  WHERE rank_row.season_id = p_season_id;

  PERFORM pg_catalog.set_config(
    'arena.leaderboard_seal_cohort', p_score_cohort_id::text, true
  );

  INSERT INTO public.leaderboard_source_freshness (
    season_id, source, source_as_of, recorded_at, score_cohort_id,
    rank_mutation_seq, published_rank_count, published_identity_sha256
  )
  SELECT p_season_id, proof.value->>'source',
    (proof.value->>'source_as_of')::timestamptz, v_published_at,
    p_score_cohort_id, (proof.value->>'rank_mutation_seq')::bigint,
    (proof.value->>'published_rank_count')::integer,
    proof.value->>'published_identity_sha256'
  FROM pg_catalog.jsonb_array_elements(v_proofs) AS proof(value)
  ON CONFLICT (season_id, source) DO UPDATE
  SET source_as_of = EXCLUDED.source_as_of,
      recorded_at = EXCLUDED.recorded_at,
      score_cohort_id = EXCLUDED.score_cohort_id,
      rank_mutation_seq = EXCLUDED.rank_mutation_seq,
      published_rank_count = EXCLUDED.published_rank_count,
      published_identity_sha256 = EXCLUDED.published_identity_sha256;

  RETURN pg_catalog.jsonb_build_object('is_sealed', true);
END;
$function$;
ALTER FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role, rogue_reader;
GRANT EXECUTE ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)
  TO service_role;

INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_type, source_trader_id, rank, arena_score,
  roi, pnl, win_rate, max_drawdown, computed_at, score_completeness,
  is_outlier, metrics_estimated, rank_publication_id
)
VALUES
  (101, '30D', 'seal_alpha', 'futures', 'alpha-one', 1, 100,
   10, 100, 60, 10, statement_timestamp(), 'full', false, false,
   '11111111-1111-4111-8111-111111111111'::uuid),
  -- Same cohort, but source is absent from captured authority.
  (102, '30D', 'outsider', 'futures', 'outsider-one', 2, 95,
   10, 100, 60, 10, statement_timestamp(), 'full', false, false,
   '11111111-1111-4111-8111-111111111111'::uuid),
  (103, '30D', 'seal_beta', 'futures', 'beta-one', 3, 90,
   10, 100, 60, 10, statement_timestamp(), 'full', false, false,
   '11111111-1111-4111-8111-111111111111'::uuid),
  (104, '30D', 'seal_alpha', 'futures', 'alpha-two', 4, 80,
   10, 100, 60, 10, statement_timestamp(), 'full', false, false,
   '11111111-1111-4111-8111-111111111111'::uuid),
  (201, '7D', 'stale_exact', 'futures', 'stale-exact', 1, 90,
   10, 100, 60, 10, statement_timestamp(), 'full', false, false,
   '77777777-7777-4777-8777-777777777777'::uuid),
  (301, '90D', 'lease_source', 'futures', 'lease-one', 1, 90,
   10, 100, 60, 10, statement_timestamp(), 'full', false, false,
   '88888888-8888-4888-8888-888888888888'::uuid);
SQL

psql_db -q -f "$SOURCE_FRESHNESS_MIGRATION"

seal_30d() {
  local cohort="$1"
  local age="$2"
  psql_db -q -c "
    SELECT public.seal_leaderboard_rank_publication(
      '30D', '$cohort'::uuid,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'source', 'seal_alpha',
          'source_as_of', pg_catalog.statement_timestamp() - interval '$age'
        ),
        pg_catalog.jsonb_build_object(
          'source', 'seal_beta',
          'source_as_of', pg_catalog.statement_timestamp() - interval '$age'
        )
      )
    );"
}

seal_30d '11111111-1111-4111-8111-111111111111' '1 hour'
psql_db -q <<'SQL'
SELECT public.seal_leaderboard_rank_publication(
  '7D', '77777777-7777-4777-8777-777777777777'::uuid,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'source', 'stale_exact',
    'source_as_of', pg_catalog.statement_timestamp() - interval '48 hours'
  ))
);
SELECT public.seal_leaderboard_rank_publication(
  '90D', '88888888-8888-4888-8888-888888888888'::uuid,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'source', 'lease_source',
    'source_as_of', pg_catalog.statement_timestamp() + interval '5 minutes'
  ))
);
SQL

VISIBLE_30D="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT COALESCE(string_agg(source_trader_id, ',' ORDER BY rank), '')
  FROM public.public_ranked_leaderboard WHERE season_id = '30D';")"
assert_equal "sealed head exposes only exact expected source cohorts" \
  "alpha-one,beta-one,alpha-two" "$VISIBLE_30D"

OFFSET_30D="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT source_trader_id FROM public.public_ranked_leaderboard
  WHERE season_id = '30D' ORDER BY rank OFFSET 1 LIMIT 1;")"
assert_equal "all authority filters run before caller pagination" "beta-one" "$OFFSET_30D"

STALE_7D="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT count(*) FROM public.public_ranked_leaderboard WHERE season_id = '7D';")"
assert_equal "exact 48h source freshness is expired" "0" "$STALE_7D"

LEASE_BOUNDS="$(psql_db -Atqc "
  SELECT
    EXISTS (
      SELECT 1 FROM arena.public_ranked_leaderboard_serving_seasons((
        SELECT source_as_of - interval '5 minutes'
        FROM public.leaderboard_source_freshness
        WHERE season_id = '90D' AND source = 'lease_source'
      )) WHERE season_id = '90D'
    )::text || '|' ||
    EXISTS (
      SELECT 1 FROM arena.public_ranked_leaderboard_serving_seasons((
        SELECT source_as_of - interval '5 minutes 1 microsecond'
        FROM public.leaderboard_source_freshness
        WHERE season_id = '90D' AND source = 'lease_source'
      )) WHERE season_id = '90D'
    )::text || '|' ||
    EXISTS (
      SELECT 1 FROM arena.public_ranked_leaderboard_serving_seasons((
        SELECT rank_valid_until + interval '1 microsecond'
        FROM arena.public_ranked_leaderboard_serving_heads WHERE season_id = '90D'
      )) WHERE season_id = '90D'
    )::text;")"
assert_equal "future bound is inclusive and computed lease expiry is fail-closed" \
  "true|false|false" "$LEASE_BOUNDS"

ACL_CONTRACT="$(psql_db -Atqc "
  SELECT
    has_function_privilege('anon',
      'public.arena_leaderboard_publication_proofs(text,text[])', 'EXECUTE')::text
    || '|' || has_function_privilege('authenticated',
      'public.arena_leaderboard_publication_proofs(text,text[])', 'EXECUTE')::text
    || '|' || has_function_privilege('service_role',
      'public.arena_leaderboard_publication_proofs(text,text[])', 'EXECUTE')::text
    || '|' || has_function_privilege('anon',
      'arena.public_ranked_leaderboard_serving_seasons(timestamp with time zone)',
      'EXECUTE')::text
    || '|' || has_table_privilege('anon',
      'public.leaderboard_source_freshness', 'SELECT')::text
    || '|' || has_table_privilege('anon',
      'arena.public_ranked_leaderboard_serving_heads', 'SELECT')::text;")"
assert_equal "full proof/source tokens remain private; season capability is callable" \
  "false|false|true|true|false|false" "$ACL_CONTRACT"

# A raw marker on a historical publication cannot repopulate a deleted head.
psql_db -q <<'SQL'
DELETE FROM ONLY arena.public_ranked_leaderboard_serving_heads WHERE season_id = '30D';
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config(
  'arena.leaderboard_seal_cohort',
  '11111111-1111-4111-8111-111111111111',
  true
);
UPDATE public.leaderboard_source_freshness
SET recorded_at = recorded_at
WHERE season_id = '30D' AND source = 'seal_alpha';
COMMIT;
SQL

RAW_BACKFILL="$(psql_db -Atqc "
  SELECT count(*) FROM ONLY arena.public_ranked_leaderboard_serving_heads
  WHERE season_id = '30D';")"
assert_equal "historical receipt plus raw marker cannot establish a head" "0" "$RAW_BACKFILL"

psql_db -q <<'SQL'
UPDATE public.leaderboard_ranks
SET rank_publication_id = '22222222-2222-4222-8222-222222222222'::uuid
WHERE season_id = '30D' AND source IN ('seal_alpha', 'seal_beta');
SQL
seal_30d '22222222-2222-4222-8222-222222222222' '30 minutes'

RESEALED="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT count(*) FROM public.public_ranked_leaderboard WHERE season_id = '30D';")"
assert_equal "new actual seal restores the season head" "3" "$RESEALED"

# A freshness tuple drift invalidates the complete globally ordered season.
psql_db -q <<'SQL'
UPDATE public.leaderboard_source_freshness
SET source_as_of = statement_timestamp() - interval '5 minutes'
WHERE season_id = '30D' AND source = 'seal_beta';
SQL
FRESHNESS_DRIFT="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT count(*) FROM public.public_ranked_leaderboard WHERE season_id = '30D';")"
assert_equal "one source proof drift hides every source in the season" "0" "$FRESHNESS_DRIFT"

psql_db -q <<'SQL'
UPDATE public.leaderboard_ranks
SET rank_publication_id = '33333333-3333-4333-8333-333333333333'::uuid
WHERE season_id = '30D' AND source IN ('seal_alpha', 'seal_beta');
SQL
seal_30d '33333333-3333-4333-8333-333333333333' '10 minutes'

# Beta DML must invalidate alpha too, because rank ordering is season-global.
psql_db -q <<'SQL'
UPDATE public.leaderboard_ranks
SET handle = 'Beta changed'
WHERE season_id = '30D' AND source = 'seal_beta';
SQL
OTHER_SOURCE_DML="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT count(*) FROM public.public_ranked_leaderboard
  WHERE season_id = '30D' AND source = 'seal_alpha';")"
assert_equal "other-source rank DML invalidates the full season" "0" "$OTHER_SOURCE_DML"

psql_db -q <<'SQL'
UPDATE public.leaderboard_ranks
SET rank_publication_id = '44444444-4444-4444-8444-444444444444'::uuid
WHERE season_id = '30D' AND source IN ('seal_alpha', 'seal_beta');
SQL
seal_30d '44444444-4444-4444-8444-444444444444' '5 minutes'
psql_db -q <<'SQL'
INSERT INTO arena.sources (slug, exchange_id, status, serving_mode, seasons)
VALUES ('registry_drift', 1, 'active', 'serving', ARRAY['30D']::text[]);
SQL

REGISTRY_DRIFT="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT count(*) FROM public.public_ranked_leaderboard WHERE season_id = '30D';")"
assert_equal "registry source-set drift invalidates the whole head" "0" "$REGISTRY_DRIFT"

psql_db -q <<'SQL'
DELETE FROM arena.sources WHERE slug = 'registry_drift';
SQL
REGISTRY_RESTORED="$(psql_db -Atqc "
  SET ROLE anon;
  SELECT COALESCE(string_agg(source_trader_id, ',' ORDER BY rank), '')
  FROM public.public_ranked_leaderboard WHERE season_id = '30D';")"
assert_equal "exact registry restoration revalidates the sealed head" \
  "alpha-one,beta-one,alpha-two" "$REGISTRY_RESTORED"

VIEW_CONTRACT="$(psql_db -Atqc "
  SELECT
    (relation.reloptions @> ARRAY[
      'security_barrier=true', 'security_invoker=false'
    ]::text[])::text || '|' ||
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.public_ranked_leaderboard'::regclass
        AND attribute.attname = 'rank_publication_id'
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
    )::text
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.public_ranked_leaderboard'::regclass;")"
assert_equal "public view keeps barrier and omits cohort token" "true|false" "$VIEW_CONTRACT"

VIEW_PLAN="$(psql_db -Atqc "
  EXPLAIN (COSTS OFF)
  SELECT source_trader_id FROM public.public_ranked_leaderboard
  WHERE season_id = '30D' ORDER BY rank LIMIT 25;")"
if [[ "$VIEW_PLAN" == *"arena_leaderboard_publication_proofs"* || \
      "$VIEW_PLAN" == *"WindowAgg"* ]]; then
  echo "public serving plan unexpectedly invokes the full-proof/window path" >&2
  exit 1
fi

set +e
psql_db -q >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE anon;
SELECT * FROM public.arena_leaderboard_publication_proofs(
  '30D', ARRAY['seal_alpha', 'seal_beta']::text[]
);
SQL
DIRECT_PROOF_STATUS=$?
set -e
if ((DIRECT_PROOF_STATUS == 0)); then
  echo "anon unexpectedly executed the full publication proof" >&2
  exit 1
fi
rg -q 'permission denied for function arena_leaderboard_publication_proofs' "$ERROR_FILE" || {
  echo "full proof denial failed for an unexpected reason" >&2
  sed -n '1,120p' "$ERROR_FILE" >&2
  exit 1
}

set +e
psql_db -q >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE anon;
SELECT * FROM public.leaderboard_source_freshness;
SQL
DIRECT_FRESHNESS_STATUS=$?
set -e
if ((DIRECT_FRESHNESS_STATUS == 0)); then
  echo "anon unexpectedly read source proof tuples" >&2
  exit 1
fi
rg -q 'permission denied for table leaderboard_source_freshness' "$ERROR_FILE" || {
  echo "source tuple denial failed for an unexpected reason" >&2
  sed -n '1,120p' "$ERROR_FILE" >&2
  exit 1
}

echo "public ranked leaderboard PG17 proof passed"
