#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for the private typed rank batch contract.
# Direct execution reuses the persisted-codec fixture; sourcing is reserved for
# that proof's opt-in extension point after its clean replay checkpoint.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TYPED_MIGRATION="$ROOT_DIR/supabase/migrations/20260725017000_leaderboard_rank_typed_batch_contract.sql"

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  export LEADERBOARD_TYPED_BATCH_PG17_EXTENSION=1
  exec bash \
    "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-persisted-codec.pg17.sh"
fi
if [[ "${LEADERBOARD_TYPED_BATCH_PG17_EXTENSION:-}" != '1' ]]; then
  echo 'typed batch proof must be sourced by the persisted-codec fixture' >&2
  exit 1
fi

expect_typed_migration_failure() {
  local label="$1"
  local pattern="$2"
  if psql_cmd -q -f "$TYPED_MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,240p' "$ERROR_FILE" >&2
    exit 1
  fi
}

# Partial object sets and same-name overloads are hostile state, not an
# invitation for a replaying migration to converge or silently repair them.
psql_cmd -q -c \
  'CREATE TYPE arena.leaderboard_rank_batch_row_v1 AS (hostile text)'
expect_typed_migration_failure \
  'typed migration accepted a partial install' \
  'typed rank batch contract is only partially installed'
psql_cmd -q -c 'DROP TYPE arena.leaderboard_rank_batch_row_v1'

psql_cmd -q <<'SQL'
CREATE FUNCTION
  arena.build_leaderboard_rank_generation_write_set_sha256_v1(p_value text)
RETURNS text LANGUAGE sql STABLE AS 'SELECT NULL::text';
SQL
expect_typed_migration_failure \
  'typed migration accepted a hostile overload' \
  'typed rank batch contract has a noncanonical overload'
psql_cmd -q -c \
  'DROP FUNCTION arena.build_leaderboard_rank_generation_write_set_sha256_v1(text)'

psql_cmd -q <<'SQL'
CREATE FUNCTION arena.encode_leaderboard_rank_row_v1(p_value text)
RETURNS jsonb LANGUAGE sql STABLE STRICT PARALLEL SAFE
AS 'SELECT NULL::jsonb';
SQL
expect_typed_migration_failure \
  'typed migration accepted a codec dependency overload' \
  'persisted rank codec dependency has a noncanonical overload'
psql_cmd -q -c 'DROP FUNCTION arena.encode_leaderboard_rank_row_v1(text)'

psql_cmd -q -f "$TYPED_MIGRATION"

CATALOG_STATE="$(psql_cmd -At -c "
  SELECT pg_catalog.string_agg(
    function_row.proname || '|' ||
    function_row.proowner::pg_catalog.regrole::text || '|' ||
    function_row.provolatile::text || '|' ||
    function_row.proparallel::text || '|' ||
    function_row.prosecdef::text || '|' ||
    function_row.proisstrict::text || '|' ||
    pg_catalog.array_to_string(function_row.proconfig, ',') || '|' ||
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    ),
    E'\\n' ORDER BY function_row.proname COLLATE pg_catalog.\"C\"
  )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid IN (
    'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure,
    'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure
  );
")"
if [[ "$CATALOG_STATE" != *'build_leaderboard_rank_typed_batch_evidence_v1|postgres|s|s|false|false|search_path=pg_catalog, pg_temp,TimeZone=UTC|7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e'* \
   || "$CATALOG_STATE" != *'build_leaderboard_rank_generation_write_set_sha256_v1|postgres|s|s|false|false|search_path=pg_catalog, pg_temp,TimeZone=UTC|f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d'* ]]; then
  echo "typed batch function catalog state is unexpected" >&2
  printf '%s\n' "$CATALOG_STATE" >&2
  exit 1
fi

if [[ "$(psql_cmd -At -c "
  WITH type_relation AS (
    SELECT type_row.typrelid
    FROM pg_catalog.pg_type AS type_row
    WHERE type_row.oid = 'arena.leaderboard_rank_batch_row_v1'::regtype
  )
  SELECT pg_catalog.count(*)::text || '|' ||
    pg_catalog.count(*) FILTER (
      WHERE attribute.attname IN (
        'id', 'season_id', 'computed_at', 'rank_publication_id'
      )
    )::text
  FROM pg_catalog.pg_attribute AS attribute
  JOIN type_relation ON type_relation.typrelid = attribute.attrelid
  WHERE attribute.attnum > 0 AND NOT attribute.attisdropped;
")" != '33|0' ]]; then
  echo "typed row exposed a server-owned field or lost a business field" >&2
  exit 1
fi

# Test-only projection of a physical rank row into the exact 33-field payload.
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.fixture_rank_to_typed_row_v1(
  p_rank public.leaderboard_ranks
)
RETURNS arena.leaderboard_rank_batch_row_v1
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT ROW(
    (p_rank).source,
    (p_rank).source_type,
    (p_rank).source_trader_id,
    (p_rank).rank,
    (p_rank).arena_score,
    (p_rank).roi,
    (p_rank).pnl,
    (p_rank).win_rate,
    (p_rank).max_drawdown,
    (p_rank).followers,
    (p_rank).trades_count,
    (p_rank).handle,
    (p_rank).avatar_url,
    (p_rank).profitability_score,
    (p_rank).risk_control_score,
    (p_rank).execution_score,
    (p_rank).score_completeness,
    (p_rank).trading_style,
    (p_rank).avg_holding_hours,
    (p_rank).style_confidence,
    (p_rank).sharpe_ratio,
    (p_rank).sortino_ratio,
    (p_rank).profit_factor,
    (p_rank).calmar_ratio,
    (p_rank).trader_type,
    (p_rank).is_outlier,
    (p_rank).metrics_estimated,
    (p_rank).rank_change,
    (p_rank).is_new,
    (p_rank).copiers,
    (p_rank).arena_score_v4,
    (p_rank).arena_score_v3,
    (p_rank).score_factors
  )::arena.leaderboard_rank_batch_row_v1;
$function$;
SQL

TYPED_EVIDENCE="$(psql_cmd -At -c "
  WITH typed_rows AS (
    SELECT pg_catalog.array_agg(
      arena.fixture_rank_to_typed_row_v1(rank_row)
      ORDER BY source DESC, source_trader_id DESC
    ) AS value
    FROM public.leaderboard_ranks AS rank_row
    WHERE season_id = '90D'
      AND rank_publication_id = '11111111-1111-4111-8111-111111111111'
      AND source IN ('alpha', 'beta')
  ), evidence AS (
    SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D',
      '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123456+00',
      typed_rows.value
    ) AS value
    FROM typed_rows
  )
  SELECT pg_catalog.concat_ws(
    '|',
    value->>'contract', value->>'season_id', value->>'score_cohort_id',
    value->>'row_count', value->>'source_count', value->>'first_source',
    value->>'first_source_trader_id', value->>'last_source',
    value->>'last_source_trader_id', value->>'batch_sha256',
    value->>'canonical_octet_length'
  )
  FROM evidence;
")"
EXPECTED_TYPED_EVIDENCE='leaderboard-rank-persisted-batch-evidence@1|90D|11111111-1111-4111-8111-111111111111|2|2|alpha|trader-1|beta|trader-2|6e36eea539e6854152727597f8791aa80692d90b1d084445b9d4757a38dfd8c6|873'
if [[ "$TYPED_EVIDENCE" != "$EXPECTED_TYPED_EVIDENCE" ]]; then
  echo "typed batch golden evidence diverged from the persisted codec" >&2
  printf 'actual: %s\n' "$TYPED_EVIDENCE" >&2
  exit 1
fi

# Equality covers the complete evidence object, including C-ordered source
# proofs. Reversing the caller array must not affect the result.
if [[ "$(psql_cmd -At -c "
  WITH typed_rows AS (
    SELECT pg_catalog.array_agg(
      arena.fixture_rank_to_typed_row_v1(rank_row)
      ORDER BY source DESC, source_trader_id DESC
    ) AS value
    FROM public.leaderboard_ranks AS rank_row
    WHERE season_id = '90D' AND source IN ('alpha', 'beta')
  )
  SELECT (
    arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D', '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123456+00', typed_rows.value
    ) = arena.build_leaderboard_rank_batch_evidence_v1(
      '90D', '11111111-1111-4111-8111-111111111111',
      '[{\"source\":\"alpha\",\"source_trader_id\":\"trader-1\"},{\"source\":\"beta\",\"source_trader_id\":\"trader-2\"}]'::jsonb
    )
  )::text
  FROM typed_rows;
")" != 'true' ]]; then
  echo "typed evidence is not byte-identical to persisted evidence" >&2
  exit 1
fi

if [[ "$(psql_cmd -At -c "
  WITH typed_rows AS (
    SELECT
      pg_catalog.array_agg(
        arena.fixture_rank_to_typed_row_v1(rank_row)
        ORDER BY source COLLATE pg_catalog.\"C\"
      ) AS ascending_rows,
      pg_catalog.array_agg(
        arena.fixture_rank_to_typed_row_v1(rank_row)
        ORDER BY source COLLATE pg_catalog.\"C\" DESC
      ) AS descending_rows
    FROM public.leaderboard_ranks AS rank_row
    WHERE season_id = '90D' AND source IN ('alpha', 'beta')
  )
  SELECT (
    arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D', '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123456+00', ascending_rows
    ) = arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D', '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123456+00', descending_rows
    )
  )::text
  FROM typed_rows;
")" != 'true' ]]; then
  echo "caller typed-row order changed canonical evidence" >&2
  exit 1
fi

# All injected authority fields participate in the digest even though callers
# cannot smuggle them into an individual row.
if [[ "$(psql_cmd -At -c "
  WITH typed_rows AS (
    SELECT pg_catalog.array_agg(
      arena.fixture_rank_to_typed_row_v1(rank_row)
      ORDER BY source COLLATE pg_catalog.\"C\"
    ) AS value
    FROM public.leaderboard_ranks AS rank_row
    WHERE season_id = '90D' AND source IN ('alpha', 'beta')
  ), base AS (
    SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D', '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123456+00', value
    )->>'batch_sha256' AS digest, value
    FROM typed_rows
  )
  SELECT
    (digest <> arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '7D', '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123456+00', value
    )->>'batch_sha256')::text || '|' ||
    (digest <> arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D', '33333333-3333-4333-8333-333333333333',
      '2026-07-28 12:34:56.123456+00', value
    )->>'batch_sha256')::text || '|' ||
    (digest <> arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D', '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123457+00', value
    )->>'batch_sha256')::text
  FROM base;
")" != 'true|true|true' ]]; then
  echo "server-owned typed batch authority did not affect its digest" >&2
  exit 1
fi

# Composite identity is source-scoped: alpha/gamma intentionally share one
# trader id and must remain two independent typed rows.
if [[ "$(psql_cmd -At -c "
  WITH typed_rows AS (
    SELECT pg_catalog.array_agg(
      arena.fixture_rank_to_typed_row_v1(rank_row)
      ORDER BY source COLLATE pg_catalog.\"C\"
    ) AS value
    FROM public.leaderboard_ranks AS rank_row
    WHERE season_id = '90D' AND source IN ('alpha', 'gamma')
  )
  SELECT
    (evidence->>'row_count') || '|' ||
    (evidence->>'source_count') || '|' ||
    (evidence->>'first_source') || '|' ||
    (evidence->>'last_source')
  FROM typed_rows
  CROSS JOIN LATERAL (
    SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '90D', '11111111-1111-4111-8111-111111111111',
      '2026-07-28 12:34:56.123456+00', typed_rows.value
    ) AS evidence
  ) AS built;
")" != '2|2|alpha|gamma' ]]; then
  echo "typed batch collapsed one trader id across distinct sources" >&2
  exit 1
fi

expect_failure \
  'typed batch accepted null rows' \
  'typed rank batch header is invalid' \
  "SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',NULL)"
expect_failure \
  'typed batch accepted a 2100 timestamp' \
  'typed rank batch header is invalid' \
  "WITH r AS (SELECT arena.fixture_rank_to_typed_row_v1(rank_row) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source='alpha') SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2100-01-01 00:00:00+00',ARRAY[value]) FROM r"
expect_failure \
  'typed batch accepted an infinite timestamp' \
  'typed rank batch header is invalid' \
  "WITH r AS (SELECT arena.fixture_rank_to_typed_row_v1(rank_row) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source='alpha') SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','infinity'::timestamptz,ARRAY[value]) FROM r"

TRUST_STATE_BEFORE="$(psql_cmd -At -c "
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rank_row)
        ORDER BY source COLLATE pg_catalog.\"C\")::text,
      'UTF8'
    )), 'hex'
  )
  FROM public.leaderboard_ranks AS rank_row;
")"

expect_failure \
  'typed batch accepted a partial row among valid rows' \
  'identity or trust state is not rank-eligible' \
  "WITH typed_rows AS (SELECT array_agg(CASE WHEN source='beta' THEN jsonb_populate_record(arena.fixture_rank_to_typed_row_v1(rank_row), '{\"score_completeness\":\"partial\"}'::jsonb) ELSE arena.fixture_rank_to_typed_row_v1(rank_row) END ORDER BY source) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source IN ('alpha','beta')) SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',value) FROM typed_rows"
expect_failure \
  'typed batch accepted an unknown row among valid rows' \
  'identity or trust state is not rank-eligible' \
  "WITH typed_rows AS (SELECT array_agg(CASE WHEN source='alpha' THEN jsonb_populate_record(arena.fixture_rank_to_typed_row_v1(rank_row), '{\"score_completeness\":\"unknown\"}'::jsonb) ELSE arena.fixture_rank_to_typed_row_v1(rank_row) END ORDER BY source) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source IN ('alpha','beta')) SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',value) FROM typed_rows"
expect_failure \
  'typed batch accepted an estimated row among valid rows' \
  'identity or trust state is not rank-eligible' \
  "WITH typed_rows AS (SELECT array_agg(CASE WHEN source='beta' THEN jsonb_populate_record(arena.fixture_rank_to_typed_row_v1(rank_row), '{\"metrics_estimated\":true}'::jsonb) ELSE arena.fixture_rank_to_typed_row_v1(rank_row) END ORDER BY source) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source IN ('alpha','beta')) SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',value) FROM typed_rows"
expect_failure \
  'typed batch accepted an unknown core metric among valid rows' \
  'core metric or score is invalid' \
  "WITH typed_rows AS (SELECT array_agg(CASE WHEN source='beta' THEN jsonb_populate_record(arena.fixture_rank_to_typed_row_v1(rank_row), '{\"win_rate\":null}'::jsonb) ELSE arena.fixture_rank_to_typed_row_v1(rank_row) END ORDER BY source) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source IN ('alpha','beta')) SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',value) FROM typed_rows"

if [[ "$(psql_cmd -At -c "
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rank_row)
        ORDER BY source COLLATE pg_catalog.\"C\")::text,
      'UTF8'
    )), 'hex'
  )
  FROM public.leaderboard_ranks AS rank_row;
")" != "$TRUST_STATE_BEFORE" ]]; then
  echo "failed partial/unknown typed batch changed persisted rank state" >&2
  exit 1
fi

expect_failure \
  'typed batch accepted a duplicate composite identity' \
  'duplicate identity' \
  "WITH r AS (SELECT arena.fixture_rank_to_typed_row_v1(rank_row) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source='alpha') SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',ARRAY[value,value]) FROM r"
expect_failure \
  'typed batch accepted a zero-based array' \
  'outside resource bounds' \
  "WITH r AS (SELECT arena.fixture_rank_to_typed_row_v1(rank_row) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source='alpha') SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',array_fill(value,ARRAY[1],ARRAY[0])) FROM r"
expect_failure \
  'typed batch accepted a multidimensional row array' \
  'outside resource bounds' \
  "WITH r AS (SELECT arena.fixture_rank_to_typed_row_v1(rank_row) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source='alpha') SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',array_fill(value,ARRAY[1,1])) FROM r"
expect_failure \
  'typed batch accepted a null composite row' \
  'identity or trust state is not rank-eligible' \
  "SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',ARRAY[NULL::arena.leaderboard_rank_batch_row_v1])"
expect_failure \
  'typed batch accepted an empty array' \
  'outside resource bounds' \
  "SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',ARRAY[]::arena.leaderboard_rank_batch_row_v1[])"
expect_failure \
  'typed batch accepted 1001 rows' \
  'outside resource bounds' \
  "WITH r AS (SELECT arena.fixture_rank_to_typed_row_v1(rank_row) value FROM public.leaderboard_ranks rank_row WHERE season_id='90D' AND source='alpha') SELECT arena.build_leaderboard_rank_typed_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','2026-07-28 12:34:56.123456+00',array_agg(value)) FROM r CROSS JOIN generate_series(1,1001) n"

# The upper boundary is also byte-identical to evidence independently rebuilt
# from the 1000 persisted rows after the base fixture removed its large avatar.
if [[ "$(psql_cmd -qAt -c "
  SET statement_timeout = '20s';
  WITH typed_rows AS (
    SELECT pg_catalog.array_agg(
      arena.fixture_rank_to_typed_row_v1(rank_row)
      ORDER BY source_trader_id COLLATE pg_catalog.\"C\"
    ) AS value
    FROM public.leaderboard_ranks AS rank_row
    WHERE season_id = '30D' AND source = 'bulk'
  ), identities AS (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', source, 'source_trader_id', source_trader_id
      ) ORDER BY source_trader_id COLLATE pg_catalog.\"C\"
    ) AS value
    FROM public.leaderboard_ranks
    WHERE season_id = '30D' AND source = 'bulk'
  )
  SELECT (
    arena.build_leaderboard_rank_typed_batch_evidence_v1(
      '30D', '22222222-2222-4222-8222-222222222222',
      '2026-07-28 12:34:56+00', typed_rows.value
    ) = arena.build_leaderboard_rank_batch_evidence_v1(
      '30D', '22222222-2222-4222-8222-222222222222', identities.value
    )
  )::text
  FROM typed_rows CROSS JOIN identities;
")" != 'true' ]]; then
  echo "typed evidence diverged at the 1000-row boundary" >&2
  exit 1
fi

psql_cmd -q -c \
  'DROP FUNCTION arena.fixture_rank_to_typed_row_v1(public.leaderboard_ranks)'
if [[ "$(psql_cmd -At -c "
  SELECT pg_catalog.to_regprocedure(
    'arena.fixture_rank_to_typed_row_v1(public.leaderboard_ranks)'
  ) IS NULL;
")" != 't' ]]; then
  echo "typed proof helper escaped its fixture lifetime" >&2
  exit 1
fi

BASE_BATCH_DIGEST='6e36eea539e6854152727597f8791aa80692d90b1d084445b9d4757a38dfd8c6'
SECOND_BATCH_DIGEST='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
WRITE_SET_DIGEST="$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1(
    '90D',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '2026-07-28 12:34:56.123456+00',
    2,
    ARRAY['$BASE_BATCH_DIGEST', '$SECOND_BATCH_DIGEST']
  );
")"
EXPECTED_WRITE_SET_DIGEST='ec126bc4dc90a99ddaba2c43e558298ebb9b9cf83c33fc060d90331a420584b9'
if [[ "$WRITE_SET_DIGEST" != "$EXPECTED_WRITE_SET_DIGEST" ]]; then
  echo "generation write-set golden digest changed" >&2
  printf 'actual: %s\n' "$WRITE_SET_DIGEST" >&2
  exit 1
fi

if [[ "$(psql_cmd -At -c "
  SELECT (
    arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      '90D','11111111-1111-4111-8111-111111111111',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '2026-07-28 12:34:56.123456+00',2,
      ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']
    ) <> arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      '90D','11111111-1111-4111-8111-111111111111',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '2026-07-28 12:34:56.123456+00',2,
      ARRAY['$SECOND_BATCH_DIGEST','$BASE_BATCH_DIGEST']
    )
  )::text;
")" != 'true' ]]; then
  echo "ordered generation batch plan did not affect write-set digest" >&2
  exit 1
fi

UTC_WRITE_SET="$(psql_cmd -At -c "SET TIME ZONE 'UTC'; SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56.123456+00',2,ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']);")"
LA_WRITE_SET="$(psql_cmd -At -c "SET TIME ZONE 'America/Los_Angeles'; SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 05:34:56.123456-07',2,ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']);")"
if [[ "$UTC_WRITE_SET" != "$LA_WRITE_SET" ]]; then
  echo "session timezone changed generation write-set digest" >&2
  exit 1
fi

if [[ "$(psql_cmd -At -c "
  WITH digests(value) AS (
    VALUES
      (arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        '90D','11111111-1111-4111-8111-111111111111',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-07-28 12:34:56.123456+00',2,
        ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']
      )),
      (arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        '7D','11111111-1111-4111-8111-111111111111',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-07-28 12:34:56.123456+00',2,
        ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']
      )),
      (arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        '90D','33333333-3333-4333-8333-333333333333',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-07-28 12:34:56.123456+00',2,
        ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']
      )),
      (arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        '90D','11111111-1111-4111-8111-111111111111',
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        '2026-07-28 12:34:56.123456+00',2,
        ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']
      )),
      (arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        '90D','11111111-1111-4111-8111-111111111111',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-07-28 12:34:56.123457+00',2,
        ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']
      )),
      (arena.build_leaderboard_rank_generation_write_set_sha256_v1(
        '90D','11111111-1111-4111-8111-111111111111',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-07-28 12:34:56.123456+00',3,
        ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']
      ))
  )
  SELECT pg_catalog.count(*)::text || '|' ||
    pg_catalog.count(DISTINCT value)::text
  FROM digests;
")" != '6|6' ]]; then
  echo "generation write-set omitted an authoritative header field" >&2
  exit 1
fi

if [[ "$(psql_cmd -At -c "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('7D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',0,ARRAY[]::text[]) ~ '^[0-9a-f]{64}$';")" != 't' ]]; then
  echo "empty generation write-set was not content-addressed" >&2
  exit 1
fi

expect_failure \
  'write-set accepted a malformed manifest digest' \
  'write-set header is invalid' \
  "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','2026-07-28 12:34:56+00',1,ARRAY['$BASE_BATCH_DIGEST'])"
expect_failure \
  'write-set accepted a malformed batch digest' \
  'batch digest plan is invalid' \
  "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',1,ARRAY['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'])"
expect_failure \
  'write-set accepted impossible batch capacity' \
  'batch digest plan is invalid' \
  "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',2001,ARRAY['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST'])"
expect_failure \
  'write-set accepted a zero-based digest plan' \
  'must be one-based' \
  "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',1,array_fill('$BASE_BATCH_DIGEST'::text,ARRAY[1],ARRAY[0]))"
expect_failure \
  'write-set accepted a multidimensional digest plan' \
  'must be one-based' \
  "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',2,ARRAY[['$BASE_BATCH_DIGEST','$SECOND_BATCH_DIGEST']]::text[])"
expect_failure \
  'write-set accepted a null digest element' \
  'batch digest plan is invalid' \
  "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',1,ARRAY[NULL]::text[])"
expect_failure \
  'write-set accepted a duplicate batch digest' \
  'batch digest plan is invalid' \
  "SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('90D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',2,ARRAY['$BASE_BATCH_DIGEST','$BASE_BATCH_DIGEST'])"

# API roles and arbitrary roles cannot use the type or execute either helper.
if [[ "$(psql_cmd -At -c "
  SELECT pg_catalog.bool_or(
    pg_catalog.has_type_privilege(
      role_name,
      'arena.leaderboard_rank_batch_row_v1'::regtype,
      'USAGE'
    )
  )
  FROM (VALUES
    ('anon'), ('authenticated'), ('service_role'), ('fixture_rogue')
  ) AS roles(role_name);
")" != 'f' ]]; then
  echo "typed rank row leaked type USAGE" >&2
  exit 1
fi
if [[ "$(psql_cmd -At -c "
  SELECT pg_catalog.bool_or(
    pg_catalog.has_function_privilege(role_name, function_oid, 'EXECUTE')
  )
  FROM (VALUES
    ('anon'), ('authenticated'), ('service_role'), ('fixture_rogue')
  ) AS roles(role_name)
  CROSS JOIN (VALUES
    ('arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure),
    ('arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure)
  ) AS functions(function_oid);
")" != 'f' ]]; then
  echo "typed rank batch leaked function EXECUTE" >&2
  exit 1
fi
expect_failure \
  'service role executed the private generation write-set helper' \
  'permission denied for function' \
  "SET ROLE service_role; SELECT arena.build_leaderboard_rank_generation_write_set_sha256_v1('7D','11111111-1111-4111-8111-111111111111','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-28 12:34:56+00',0,ARRAY[]::text[])"

# Exact replay is physically inert for its type/functions and cannot mutate
# rank rows or consume their surrogate sequence.
TYPED_STATE_BEFORE="$(psql_cmd -At -c "
  SELECT pg_catalog.string_agg(value, E'\\n' ORDER BY value COLLATE pg_catalog.\"C\")
  FROM (
    SELECT 'p|' || function_row.oid::text || '|' || function_row.xmin::text ||
      '|' || function_row.ctid::text AS value
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (
      'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure,
      'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure
    )
    UNION ALL
    SELECT 't|' || type_row.oid::text || '|' || type_row.xmin::text ||
      '|' || type_row.ctid::text
    FROM pg_catalog.pg_type AS type_row
    WHERE type_row.oid = 'arena.leaderboard_rank_batch_row_v1'::regtype
  ) AS state;
")"
ROW_STATE_BEFORE="$TRUST_STATE_BEFORE"
SEQUENCE_STATE_BEFORE="$(psql_cmd -At -c \
  'SELECT last_value::text || '\''|'\'' || is_called::text FROM public.leaderboard_ranks_id_seq')"
psql_cmd -q -f "$TYPED_MIGRATION"
TYPED_STATE_AFTER="$(psql_cmd -At -c "
  SELECT pg_catalog.string_agg(value, E'\\n' ORDER BY value COLLATE pg_catalog.\"C\")
  FROM (
    SELECT 'p|' || function_row.oid::text || '|' || function_row.xmin::text ||
      '|' || function_row.ctid::text AS value
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (
      'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure,
      'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure
    )
    UNION ALL
    SELECT 't|' || type_row.oid::text || '|' || type_row.xmin::text ||
      '|' || type_row.ctid::text
    FROM pg_catalog.pg_type AS type_row
    WHERE type_row.oid = 'arena.leaderboard_rank_batch_row_v1'::regtype
  ) AS state;
")"
ROW_STATE_AFTER="$(psql_cmd -At -c "
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rank_row)
        ORDER BY source COLLATE pg_catalog.\"C\")::text,
      'UTF8'
    )), 'hex'
  )
  FROM public.leaderboard_ranks AS rank_row;
")"
SEQUENCE_STATE_AFTER="$(psql_cmd -At -c \
  'SELECT last_value::text || '\''|'\'' || is_called::text FROM public.leaderboard_ranks_id_seq')"
if [[ "$TYPED_STATE_BEFORE" != "$TYPED_STATE_AFTER" \
   || "$ROW_STATE_BEFORE" != "$ROW_STATE_AFTER" \
   || "$SEQUENCE_STATE_BEFORE" != "$SEQUENCE_STATE_AFTER" ]]; then
  echo "typed contract replay changed object, rank-row, or sequence state" >&2
  exit 1
fi

psql_cmd -q -c \
  'GRANT USAGE ON TYPE arena.leaderboard_rank_batch_row_v1 TO service_role'
expect_typed_migration_failure \
  'typed replay silently repaired a rogue type grant' \
  'type or function ACL drifted'
psql_cmd -q -c \
  'REVOKE USAGE ON TYPE arena.leaderboard_rank_batch_row_v1 FROM service_role'

psql_cmd -q -c \
  'GRANT EXECUTE ON FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks) TO fixture_rogue'
expect_typed_migration_failure \
  'typed replay accepted a non-API codec dependency grant' \
  'persisted rank codec dependency ACL drifted'
psql_cmd -q -c \
  'REVOKE EXECUTE ON FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks) FROM fixture_rogue'

psql_cmd -q <<'SQL'
CREATE FUNCTION arena.build_leaderboard_rank_typed_batch_evidence_v1(
  p_value text
)
RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT NULL::jsonb';
SQL
expect_typed_migration_failure \
  'typed replay accepted a rogue overload' \
  'noncanonical overload'
psql_cmd -q -c \
  'DROP FUNCTION arena.build_leaderboard_rank_typed_batch_evidence_v1(text)'

psql_cmd -q -c \
  'ALTER FUNCTION arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[]) VOLATILE'
expect_typed_migration_failure \
  'typed replay accepted volatility drift' \
  'write-set function drifted'
psql_cmd -q -c \
  'ALTER FUNCTION arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[]) STABLE'

psql_cmd -q -c \
  'ALTER TYPE arena.leaderboard_rank_batch_row_v1 RENAME ATTRIBUTE source TO hostile_source'
expect_typed_migration_failure \
  'typed replay accepted composite attribute drift' \
  '33-field composite contract drifted'
psql_cmd -q -c \
  'ALTER TYPE arena.leaderboard_rank_batch_row_v1 RENAME ATTRIBUTE hostile_source TO source'

# Body drift is checked last because replay intentionally refuses to recreate
# an exact routine whose reviewed bytes have been replaced.
psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION
  arena.build_leaderboard_rank_generation_write_set_sha256_v1(
    p_season_id text,
    p_score_cohort_id uuid,
    p_score_input_manifest_digest text,
    p_computed_at timestamptz,
    p_expected_rank_count integer,
    p_batch_sha256_plan text[]
  )
RETURNS text
LANGUAGE plpgsql
STABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $body$
BEGIN
  RETURN pg_catalog.repeat('0', 64);
END;
$body$;
SQL
expect_typed_migration_failure \
  'typed replay accepted a replaced write-set body' \
  'write-set function drifted'

# A drop/re-add preserves the visible name and type but changes the physical
# attnum layout. This must fail before the positional ROW cast can mis-map it.
psql_cmd -q <<'SQL'
ALTER TABLE public.leaderboard_ranks DROP COLUMN execution_score;
ALTER TABLE public.leaderboard_ranks ADD COLUMN execution_score numeric(6, 2);
SQL
expect_typed_migration_failure \
  'typed replay accepted positional parent-column drift' \
  'typed rank batch target parent contract drifted|typed rank batch 37-column target drifted'

echo 'leaderboard typed rank batch contract PG17 proof passed'
