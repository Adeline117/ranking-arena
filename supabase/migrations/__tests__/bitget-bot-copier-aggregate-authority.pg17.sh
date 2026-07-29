#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the Bitget bot copier aggregate authority.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729014000_bitget_bot_copier_aggregate_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/bitget-bot-copier-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55541
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >/dev/null 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE hostile_role NOLOGIN;

CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, hostile_role;

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL
);
ALTER TABLE arena.exchanges OWNER TO postgres;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id),
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL,
  page_size integer,
  pagination_kind text,
  copier_table_depth text NOT NULL
    CHECK (copier_table_depth IN ('full', 'top10', 'top3_preview', 'none')),
  meta jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE arena.sources OWNER TO postgres;

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  trader_kind text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);
ALTER TABLE arena.traders OWNER TO postgres;

CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  as_of timestamptz NOT NULL,
  copier_pnl numeric,
  copier_count integer,
  extras jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (trader_id, timeframe)
);
ALTER TABLE arena.trader_stats OWNER TO postgres;

CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  ts timestamptz NOT NULL,
  copier_pnl numeric,
  dedupe_hash text NOT NULL,
  PRIMARY KEY (ts, dedupe_hash)
);
ALTER TABLE arena.copier_records OWNER TO postgres;

REVOKE ALL ON ALL TABLES IN SCHEMA arena
  FROM PUBLIC, anon, authenticated, service_role, hostile_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;

INSERT INTO arena.exchanges (id, slug) VALUES
  (1, 'bitget'),
  (2, 'other');

INSERT INTO arena.sources (
  id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
  status, serving_mode, currency, timeframes_native, timeframes_derived,
  page_size, pagination_kind, copier_table_depth, meta
) VALUES
  (
    11, 'bitget_bots_futures', 1, 'futures', 'bot', 'bitget_bots',
    'active', 'serving', 'USDT', ARRAY[30], ARRAY[]::integer[],
    20, 'numeric', 'full',
    '{"boards":["futures_grid","futures_martingale"]}'
  ),
  (
    12, 'bitget_bots_spot', 1, 'spot', 'bot', 'bitget_bots',
    'active', 'serving', 'USDT', ARRAY[30], ARRAY[]::integer[],
    20, 'numeric', 'full',
    '{"boards":["spot_grid","spot_martingale"]}'
  ),
  (
    21, 'bitget_futures', 1, 'futures', 'human', 'bitget',
    'active', 'serving', 'USDT', ARRAY[7,30,90], ARRAY[]::integer[],
    30, 'numeric', 'full', '{}'
  ),
  (
    22, 'inactive_human', 2, 'futures', 'human', 'other',
    'inactive', 'shadow', 'USDT', ARRAY[30], ARRAY[]::integer[],
    20, 'numeric', 'full', '{}'
  );

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, trader_kind
) VALUES
  (101, 11, 'bot-futures', 'bot'),
  (102, 12, 'bot-spot', 'bot'),
  (103, 11, 'bot-no-evidence', 'bot'),
  (104, 11, 'bot-oversized-batch', 'bot'),
  (201, 21, 'human-active', 'human'),
  (202, 22, 'human-inactive', 'human');

WITH fixture AS (
  SELECT '2026-07-28 12:00:00+00'::timestamptz AS as_of
)
INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, copier_pnl, copier_count, extras
)
SELECT 101, timeframe, fixture.as_of, copier_pnl, copier_count,
       CASE
         WHEN timeframe = 0 THEN pg_catalog.jsonb_build_object(
           '_arena_profile_publication_epoch_ms',
           EXTRACT(EPOCH FROM fixture.as_of) * 1000
         )
         ELSE pg_catalog.jsonb_build_object(
           '_arena_profile_publication_epoch_ms',
           EXTRACT(EPOCH FROM fixture.as_of) * 1000
         )
       END
FROM fixture
CROSS JOIN (
  VALUES
    (0::smallint, 456::numeric, 123),
    (7::smallint, 7007::numeric, 707),
    (30::smallint, 3030::numeric, 330),
    (90::smallint, 9090::numeric, 990)
) AS metrics(timeframe, copier_pnl, copier_count);

WITH fixture AS (
  SELECT '2026-07-28 12:00:00+00'::timestamptz AS as_of
)
INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, copier_pnl, copier_count, extras
)
SELECT 102, 0, fixture.as_of, 333, 222,
       pg_catalog.jsonb_build_object(
         '_arena_profile_publication_epoch_ms',
         EXTRACT(EPOCH FROM fixture.as_of) * 1000 + 1
       )
FROM fixture;

INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, copier_pnl, copier_count, extras
) VALUES
  (201, 30, '2026-07-28 11:00:00+00', 888, 55, '{}'),
  (202, 30, '2026-07-28 11:00:00+00', 999, 66, '{}');

INSERT INTO arena.copier_records (
  trader_id, ts, copier_pnl, dedupe_hash
)
SELECT 101, '2026-07-28 12:05:00+00', value,
       'f-' || ord::text
FROM pg_catalog.unnest(
  ARRAY[-2000,-500,10,20,30,40,50,1500,2500,15000]::numeric[]
) WITH ORDINALITY AS sample(value, ord);

INSERT INTO arena.copier_records (
  trader_id, ts, copier_pnl, dedupe_hash
)
SELECT 102, '2026-07-28 12:06:00+00', value,
       's-' || ord::text
FROM pg_catalog.unnest(
  ARRAY[1,2,3,4,5,6,7,8,9,10]::numeric[]
) WITH ORDINALITY AS sample(value, ord);

INSERT INTO arena.copier_records (
  trader_id, ts, copier_pnl, dedupe_hash
)
SELECT 104, '2026-07-28 12:07:00+00', value,
       'o-' || value::text
FROM pg_catalog.generate_series(1, 11) AS sample(value);

INSERT INTO arena.copier_records (
  trader_id, ts, copier_pnl, dedupe_hash
) VALUES
  (201, '2026-07-28 11:05:00+00', 12, 'h-1'),
  (201, '2026-07-28 11:05:00+00', 24, 'h-2'),
  (202, '2026-07-28 11:05:00+00', 48, 'i-1');

CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(
  p_source text,
  p_trader text
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  WITH t AS (
    SELECT t.id, s.copier_table_depth, s.currency
      FROM arena.traders t
      JOIN arena.sources s ON s.id = t.source_id
     WHERE s.slug = p_source AND t.exchange_trader_id = p_trader
  ), latest AS (
    SELECT max(cr.ts) AS ts FROM arena.copier_records cr, t WHERE cr.trader_id = t.id
  ), batch AS (
    SELECT cr.copier_pnl
      FROM arena.copier_records cr, t, latest
     WHERE cr.trader_id = t.id AND cr.ts = latest.ts
  ), stats AS (
    SELECT st.copier_count, st.copier_pnl
      FROM arena.trader_stats st, t
     WHERE st.trader_id = t.id
     ORDER BY st.as_of DESC
     LIMIT 1
  )
  SELECT jsonb_build_object(
    'copierCount', COALESCE((SELECT copier_count FROM stats),
                            NULLIF((SELECT count(*) FROM batch), 0)),
    'copierCountMax', NULL,
    'totalCopierPnl', COALESCE((SELECT copier_pnl FROM stats),
                               (SELECT sum(copier_pnl) FROM batch)),
    'currency', (SELECT currency FROM t),
    'depth', (SELECT copier_table_depth FROM t),
    'asOf', COALESCE((SELECT ts FROM latest), now()),
    'pnlDistribution', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'count', cnt) ORDER BY ord)
        FROM (
          SELECT bucket, ord, count(*) AS cnt
            FROM (
              SELECT CASE
                       WHEN copier_pnl < -1000 THEN '<-1000'
                       WHEN copier_pnl < 0     THEN '-1000~0'
                       WHEN copier_pnl < 1000  THEN '0~1000'
                       WHEN copier_pnl < 10000 THEN '1000~10000'
                       ELSE '>10000'
                     END AS bucket,
                     CASE
                       WHEN copier_pnl < -1000 THEN 0
                       WHEN copier_pnl < 0     THEN 1
                       WHEN copier_pnl < 1000  THEN 2
                       WHEN copier_pnl < 10000 THEN 3
                       ELSE 4
                     END AS ord
                FROM batch
               WHERE copier_pnl IS NOT NULL
            ) b
           GROUP BY bucket, ord
        ) g
    ), '[]'::jsonb)
  )
    FROM t;
$$;
ALTER FUNCTION public.arena_copier_aggregate(text, text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated;

DO $old_nondeterminism$
DECLARE
  v_candidate_count integer;
  v_payload jsonb;
BEGIN
  SELECT pg_catalog.count(DISTINCT stats.copier_count)::integer
  INTO STRICT v_candidate_count
  FROM arena.trader_stats AS stats
  WHERE stats.trader_id = 101
    AND stats.as_of = '2026-07-28 12:00:00+00';

  v_payload := public.arena_copier_aggregate(
    'bitget_bots_futures',
    'bot-futures'
  );

  IF v_candidate_count <= 1
     OR (v_payload->>'copierCount')::integer NOT IN (123, 707, 330, 990) THEN
    RAISE EXCEPTION
      'pre-migration multi-timeframe aggregate was unexpectedly deterministic';
  END IF;
END
$old_nondeterminism$;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $trusted_inception$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_copier_aggregate(
    'bitget_bots_futures',
    'bot-futures'
  );
  RESET ROLE;

  IF (v_payload->>'copierCount')::integer <> 123
     OR (v_payload->>'totalCopierPnl')::numeric <> 456
     OR v_payload->>'depth' <> 'top10'
     OR (v_payload->>'asOf')::timestamptz <>
          '2026-07-28 12:05:00+00'::timestamptz
     OR pg_catalog.jsonb_array_length(v_payload->'pnlDistribution') <> 5 THEN
    RAISE EXCEPTION 'trusted inception totals were not authoritative: %', v_payload;
  END IF;
END
$trusted_inception$;

UPDATE arena.trader_stats
SET as_of = '2026-07-28 12:10:00+00',
    extras = pg_catalog.jsonb_build_object(
      '_arena_profile_publication_epoch_ms',
      EXTRACT(
        EPOCH FROM '2026-07-28 12:10:00+00'::timestamptz
      ) * 1000
    )
WHERE trader_id = 101
  AND timeframe = 0;

DO $newer_profile_as_of$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  v_payload := public.arena_copier_aggregate(
    'bitget_bots_futures',
    'bot-futures'
  );
  RESET ROLE;
  IF (v_payload->>'asOf')::timestamptz <>
       '2026-07-28 12:10:00+00'::timestamptz THEN
    RAISE EXCEPTION
      'newer trusted profile timestamp lost to an older Top-10 batch: %',
      v_payload;
  END IF;
END
$newer_profile_as_of$;

DO $untrusted_profile$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  v_payload := public.arena_copier_aggregate(
    'bitget_bots_spot',
    'bot-spot'
  );
  RESET ROLE;

  IF v_payload->'copierCount' <> 'null'::jsonb
     OR v_payload->'totalCopierPnl' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'untrusted profile totals leaked: %', v_payload;
  END IF;
  IF (v_payload->>'copierCount') IS NOT NULL
     OR (v_payload->>'totalCopierPnl') IS NOT NULL
     OR pg_catalog.jsonb_array_length(v_payload->'pnlDistribution') <> 1
     OR (v_payload->>'asOf')::timestamptz <>
          '2026-07-28 12:06:00+00'::timestamptz THEN
    RAISE EXCEPTION 'Top-10 batch was promoted to a total: %', v_payload;
  END IF;
END
$untrusted_profile$;

DO $non_bot_compatibility$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_copier_aggregate(
    'bitget_futures',
    'human-active'
  );
  RESET ROLE;

  IF (v_payload->>'copierCount')::integer <> 55
     OR (v_payload->>'totalCopierPnl')::numeric <> 888
     OR v_payload->>'depth' <> 'full'
     OR pg_catalog.jsonb_array_length(v_payload->'pnlDistribution') <> 1
     OR (v_payload->>'asOf')::timestamptz <>
          '2026-07-28 11:05:00+00'::timestamptz THEN
    RAISE EXCEPTION 'non-Bot aggregate behavior regressed: %', v_payload;
  END IF;
END
$non_bot_compatibility$;

DO $inactive_closed$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_copier_aggregate(
    'inactive_human',
    'human-inactive'
  );
  RESET ROLE;
  IF v_payload IS NOT NULL THEN
    RAISE EXCEPTION 'inactive source remained publicly readable: %', v_payload;
  END IF;
END
$inactive_closed$;

DO $no_evidence_closed$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  v_payload := public.arena_copier_aggregate(
    'bitget_bots_futures',
    'bot-no-evidence'
  );
  RESET ROLE;
  IF v_payload IS NOT NULL THEN
    RAISE EXCEPTION
      'canonical Bot without evidence did not return SQL NULL: %',
      v_payload;
  END IF;
END
$no_evidence_closed$;

DO $oversized_batch_closed$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_copier_aggregate(
    'bitget_bots_futures',
    'bot-oversized-batch'
  );
  RESET ROLE;
  IF v_payload IS NOT NULL THEN
    RAISE EXCEPTION
      'oversized Top-10 batch did not fail closed: %',
      v_payload;
  END IF;
END
$oversized_batch_closed$;

UPDATE arena.sources
SET adapter_slug = 'drifted_bitget_bots'
WHERE slug = 'bitget_bots_futures';

DO $canonical_drift_closed$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_copier_aggregate(
    'bitget_bots_futures',
    'bot-futures'
  );
  RESET ROLE;
  IF v_payload IS NOT NULL THEN
    RAISE EXCEPTION
      'canonical source-contract drift did not return SQL NULL: %',
      v_payload;
  END IF;
END
$canonical_drift_closed$;

UPDATE arena.sources
SET adapter_slug = 'bitget_bots'
WHERE slug = 'bitget_bots_futures';

INSERT INTO arena.sources (
  id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
  status, serving_mode, currency, timeframes_native, timeframes_derived,
  page_size, pagination_kind, copier_table_depth, meta
) VALUES (
  31, 'unreviewed_bot_adapter', 1, 'futures', 'bot', 'bitget_bots',
  'active', 'serving', 'USDT', ARRAY[30], ARRAY[]::integer[],
  20, 'numeric', 'full', '{}'
);
INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, trader_kind
) VALUES (301, 31, 'rogue-bot', 'bot');
INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, copier_pnl, copier_count, extras
) VALUES (
  301,
  0,
  '2026-07-28 12:00:00+00',
  999999,
  999999,
  pg_catalog.jsonb_build_object(
    '_arena_profile_publication_epoch_ms',
    EXTRACT(
      EPOCH FROM '2026-07-28 12:00:00+00'::timestamptz
    ) * 1000
  )
);

DO $rogue_adapter_closed$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_copier_aggregate(
    'unreviewed_bot_adapter',
    'rogue-bot'
  );
  RESET ROLE;
  IF v_payload IS NOT NULL THEN
    RAISE EXCEPTION 'rogue Bitget bot adapter source leaked: %', v_payload;
  END IF;
END
$rogue_adapter_closed$;

INSERT INTO arena.sources (
  id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
  status, serving_mode, currency, timeframes_native, timeframes_derived,
  page_size, pagination_kind, copier_table_depth, meta
) VALUES (
  32, 'future_bot_generation', 1, 'futures', 'bot', 'bitget_bots_v2',
  'active', 'serving', 'USDT', ARRAY[30], ARRAY[]::integer[],
  20, 'numeric', 'full', '{}'
);
INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, trader_kind
) VALUES (302, 32, 'future-bot', 'bot');
INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, copier_pnl, copier_count, extras
) VALUES (
  302,
  0,
  '2026-07-28 12:00:00+00',
  888888,
  888888,
  pg_catalog.jsonb_build_object(
    '_arena_profile_publication_epoch_ms',
    EXTRACT(
      EPOCH FROM '2026-07-28 12:00:00+00'::timestamptz
    ) * 1000
  )
);

DO $future_adapter_closed$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  v_payload := public.arena_copier_aggregate(
    'future_bot_generation',
    'future-bot'
  );
  RESET ROLE;
  IF v_payload IS NOT NULL THEN
    RAISE EXCEPTION
      'unknown Bitget bot adapter generation leaked: %',
      v_payload;
  END IF;
END
$future_adapter_closed$;

UPDATE arena.sources
SET status = 'inactive', serving_mode = 'shadow'
WHERE id IN (31, 32);
SQL

expect_failure \
  "SET ROLE anon; SELECT * FROM arena.trader_stats" \
  "browser direct stats read bypass remained"
expect_failure \
  "SET ROLE authenticated; SELECT * FROM arena.copier_records" \
  "browser direct copier read bypass remained"
expect_failure \
  "SET ROLE hostile_role; SELECT public.arena_copier_aggregate('bitget_futures','human-active')" \
  "hostile PUBLIC execute bypass remained"
expect_failure \
  "UPDATE arena.sources SET copier_table_depth = 'full' WHERE slug = 'bitget_bots_futures'" \
  "Bitget bot copier depth constraint was bypassed"

# Reapply after convergence. The inactive rogue adapter remains fail-closed and
# does not expand the reviewed active-source authority set.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $final_contract$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_row
  FROM pg_catalog.pg_proc
  WHERE oid = v_function;

  IF v_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_row.prosecdef
     OR v_row.provolatile <> 's'
     OR v_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         COALESCE(
           v_row.proacl,
           pg_catalog.acldefault('f', v_row.proowner)
         )
       ) AS privilege
       WHERE privilege.privilege_type = 'EXECUTE'
         AND (
           privilege.is_grantable
           OR privilege.grantee = 0::oid
           OR privilege.grantee <> ALL (
             ARRAY[
               v_row.proowner,
               'anon'::regrole::oid,
               'authenticated'::regrole::oid,
               'service_role'::regrole::oid
             ]::oid[]
           )
         )
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.aclexplode(v_row.proacl) AS privilege
       WHERE privilege.privilege_type = 'EXECUTE'
     ) <> 4 THEN
    RAISE EXCEPTION 'final copier aggregate callable contract drifted';
  END IF;
END
$final_contract$;
SQL

echo "Bitget bot copier aggregate authority PG17 proof passed"
