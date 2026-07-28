#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for dormant generation receipt tables.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLAIM_MIGRATION="$ROOT_DIR/supabase/migrations/20260725015000_leaderboard_rank_generation_claim.sql"
CAPACITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260725015500_bound_leaderboard_rank_generation_batches.sql"
RECEIPT_MIGRATION="$ROOT_DIR/supabase/migrations/20260725016000_leaderboard_rank_generation_receipt_substrate.sql"
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

TMP_ROOT="$(mktemp -d /tmp/rank-generation-receipts-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
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

expect_failure() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,200p' "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_receipt_migration_failure() {
  local label="$1"
  local pattern="$2"
  if psql_cmd -q -f "$RECEIPT_MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,240p' "$ERROR_FILE" >&2
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
GRANT USAGE ON SCHEMA arena
  TO anon, authenticated, service_role, fixture_rogue;

CREATE FUNCTION extensions.gen_random_uuid()
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $function$
  SELECT pg_catalog.gen_random_uuid()
$function$;

CREATE FUNCTION arena.reject_leaderboard_rank_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'leaderboard publication receipts are immutable'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION arena.reject_leaderboard_rank_publication_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_rank_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role, fixture_rogue;

CREATE TABLE arena.leaderboard_score_input_manifests (
  manifest_id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  manifest_digest text NOT NULL UNIQUE,
  period text NOT NULL,
  manifest jsonb NOT NULL,
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT leaderboard_score_input_manifest_digest_shape
    CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT leaderboard_score_input_manifest_period
    CHECK (period IN ('7D', '30D', '90D')),
  CONSTRAINT leaderboard_score_input_manifest_object
    CHECK (pg_catalog.jsonb_typeof(manifest) = 'object'),
  CONSTRAINT leaderboard_score_input_manifest_scalar_binding
    CHECK (
      (
        manifest->>'contract' = 'leaderboard-score-input-manifest@1'
        AND manifest->>'manifestDigest' = manifest_digest
        AND manifest->>'period' = period
        AND (manifest->>'validUntil')::timestamptz = valid_until
      ) IS TRUE
    ),
  CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl
    CHECK (
      (
        pg_catalog.jsonb_typeof(manifest->'inputs') = 'array'
        AND pg_catalog.jsonb_array_length(manifest->'inputs') =
            pg_catalog.jsonb_array_length(
              pg_catalog.jsonb_path_query_array(
                manifest->'inputs',
                '$[*] ? (@.pnl.type() == "number")'::pg_catalog.jsonpath
              )
            )
      ) IS TRUE
    )
);
ALTER TABLE arena.leaderboard_score_input_manifests
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arena.leaderboard_score_input_manifests
  FROM PUBLIC, anon, authenticated, service_role, fixture_rogue;

CREATE TABLE arena.leaderboard_rank_mutation_fences (
  season_id text NOT NULL
    CHECK (season_id IN ('7D', '30D', '90D')),
  source text NOT NULL,
  mutation_seq bigint NOT NULL DEFAULT 0 CHECK (mutation_seq >= 0),
  mutated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (season_id, source)
);
ALTER TABLE arena.leaderboard_rank_mutation_fences
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arena.leaderboard_rank_mutation_fences
  FROM PUBLIC, anon, authenticated, service_role, fixture_rogue;
SQL

psql_cmd -q -f "$CLAIM_MIGRATION"
psql_cmd -q -f "$CAPACITY_MIGRATION"

# A partial same-name install must fail before changing the manifest parent.
psql_cmd -q -c \
  'CREATE TABLE arena.leaderboard_rank_generation_manifest_bindings (rogue text);'
expect_receipt_migration_failure \
  "receipt migration accepted a partial install" \
  "receipt objects are only partially installed"
if [[ "$(psql_cmd -Atqc "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'arena.leaderboard_score_input_manifests'::regclass AND conname = 'leaderboard_score_input_manifests_identity_digest_period_key');")" != "t" ]]; then
  echo "partial receipt install changed the manifest parent" >&2
  exit 1
fi
psql_cmd -q -c \
  'DROP TABLE arena.leaderboard_rank_generation_manifest_bindings;'

# The claim callable is SECURITY DEFINER generation authority. Receipt install
# must reject both widened function EXECUTE and parent-column privileges, and
# it must leave hostile evidence untouched instead of repairing it.
psql_cmd -q -c \
  'GRANT EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer) TO anon;'
expect_receipt_migration_failure \
  "receipt migration accepted anon claim execute" \
  "bounded generation claim RPC EXECUTE ACL drifted"
if [[ "$(psql_cmd -Atqc "SELECT has_function_privilege('anon','public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)','EXECUTE');")" != "t" ]]; then
  echo "claim RPC ACL rejection silently repaired the rogue grant" >&2
  exit 1
fi
psql_cmd -q -c \
  'REVOKE EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer) FROM anon;'

psql_cmd -q -c \
  "CREATE FUNCTION public.claim_leaderboard_rank_generation() RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object();';"
expect_receipt_migration_failure \
  "receipt migration accepted a claim RPC overload" \
  "bounded generation claim RPC contract drifted"
psql_cmd -q -c \
  'DROP FUNCTION public.claim_leaderboard_rank_generation();'

psql_cmd -q -c \
  'GRANT UPDATE (mutation_seq) ON arena.leaderboard_rank_mutation_fences TO service_role;'
expect_receipt_migration_failure \
  "receipt migration accepted a parent column grant" \
  "generation receipt parent ACL, rule, or policy drifted"
if [[ "$(psql_cmd -Atqc "SELECT has_column_privilege('service_role','arena.leaderboard_rank_mutation_fences','mutation_seq','UPDATE');")" != "t" ]]; then
  echo "parent column ACL rejection silently repaired the rogue grant" >&2
  exit 1
fi
psql_cmd -q -c \
  'REVOKE UPDATE (mutation_seq) ON arena.leaderboard_rank_mutation_fences FROM service_role;'

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_mutation_fences ALTER COLUMN mutation_seq SET DEFAULT 7;'
expect_receipt_migration_failure \
  "receipt migration accepted a hostile fence default" \
  "generation receipt exact parent catalog drifted"
if [[ "$(psql_cmd -Atqc "SELECT pg_get_expr(adbin,adrelid,false) FROM pg_catalog.pg_attrdef WHERE adrelid='arena.leaderboard_rank_mutation_fences'::regclass AND adnum=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid='arena.leaderboard_rank_mutation_fences'::regclass AND attname='mutation_seq');")" != "7" ]]; then
  echo "parent default rejection silently repaired hostile drift" >&2
  exit 1
fi
psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_mutation_fences ALTER COLUMN mutation_seq SET DEFAULT 0;'

psql_cmd -q <<'SQL'
ALTER TABLE arena.leaderboard_rank_generation_heads
  DROP CONSTRAINT leaderboard_rank_generation_heads_claim_fkey;
ALTER TABLE arena.leaderboard_rank_generation_heads
  ADD CONSTRAINT leaderboard_rank_generation_heads_claim_fkey
  FOREIGN KEY (season_id, generation_seq, score_cohort_id)
  REFERENCES arena.leaderboard_rank_generation_claims (
    season_id, generation_seq, score_cohort_id
  ) ON DELETE CASCADE;
SQL
expect_receipt_migration_failure \
  "receipt migration accepted a cascading generation-head FK" \
  "generation receipt exact parent catalog drifted"
if ! psql_cmd -Atqc "SELECT pg_get_constraintdef(oid,true) FROM pg_catalog.pg_constraint WHERE conrelid='arena.leaderboard_rank_generation_heads'::regclass AND conname='leaderboard_rank_generation_heads_claim_fkey';" | rg -q 'ON DELETE CASCADE'; then
  echo "parent FK rejection silently repaired hostile drift" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
ALTER TABLE arena.leaderboard_rank_generation_heads
  DROP CONSTRAINT leaderboard_rank_generation_heads_claim_fkey;
ALTER TABLE arena.leaderboard_rank_generation_heads
  ADD CONSTRAINT leaderboard_rank_generation_heads_claim_fkey
  FOREIGN KEY (season_id, generation_seq, score_cohort_id)
  REFERENCES arena.leaderboard_rank_generation_claims (
    season_id, generation_seq, score_cohort_id
  );
SQL

psql_cmd -q -f "$RECEIPT_MIGRATION"

psql_cmd -q <<'SQL'
WITH manifest_basis (
  manifest_id,
  period,
  valid_until,
  created_at,
  basis
) AS (
  VALUES
    (
      '11111111-1111-4111-8111-111111111111'::uuid,
      '7D'::text,
      '2099-01-01 00:00:00+00'::timestamptz,
      '2026-07-25 00:00:00+00'::timestamptz,
      pg_catalog.jsonb_build_object(
        'contract', 'leaderboard-score-input-manifest@1',
        'period', '7D',
        'validUntil', '2099-01-01T00:00:00.000000Z',
        'inputs', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('pnl', 1),
          pg_catalog.jsonb_build_object('pnl', 2)
        )
      )
    ),
    (
      '22222222-2222-4222-8222-222222222222'::uuid,
      '30D'::text,
      '2099-01-01 00:00:00+00'::timestamptz,
      '2026-07-25 00:00:00+00'::timestamptz,
      pg_catalog.jsonb_build_object(
        'contract', 'leaderboard-score-input-manifest@1',
        'period', '30D',
        'validUntil', '2099-01-01T00:00:00.000000Z',
        'inputs', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('pnl', 3)
        )
      )
    ),
    (
      '33333333-3333-4333-8333-333333333333'::uuid,
      '30D'::text,
      '2099-01-01 00:00:00+00'::timestamptz,
      '2026-07-25 00:00:00+00'::timestamptz,
      pg_catalog.jsonb_build_object(
        'contract', 'leaderboard-score-input-manifest@1',
        'period', '30D',
        'validUntil', '2099-01-01T00:00:00.000000Z',
        'inputs', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('pnl', 4)
        )
      )
    )
), digested AS (
  SELECT
    manifest_basis.*,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(manifest_basis.basis::text, 'UTF8')
      ),
      'hex'
    ) AS manifest_digest
  FROM manifest_basis
)
INSERT INTO arena.leaderboard_score_input_manifests (
  manifest_id,
  manifest_digest,
  period,
  manifest,
  valid_until,
  created_at
)
SELECT
  digested.manifest_id,
  digested.manifest_digest,
  digested.period,
  digested.basis || pg_catalog.jsonb_build_object(
    'manifestDigest', digested.manifest_digest
  ),
  digested.valid_until,
  digested.created_at
FROM digested;

INSERT INTO arena.leaderboard_rank_mutation_fences (
  season_id,
  source,
  mutation_seq,
  mutated_at
) VALUES
  ('7D', 'binance', 1, '2026-07-25 00:00:00+00'::timestamptz),
  ('7D', 'okx', 1, '2026-07-25 00:00:00+00'::timestamptz),
  ('7D', 'bybit', 1, '2026-07-25 00:00:00+00'::timestamptz);

SET ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '7D',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  pg_catalog.repeat('d', 64),
  2,
  1,
  '2026-07-25 00:00:00+00'::timestamptz,
  300
);
SELECT public.claim_leaderboard_rank_generation(
  '30D',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
  pg_catalog.repeat('e', 64),
  1,
  1,
  '2026-07-25 00:00:00+00'::timestamptz,
  300
);
RESET ROLE;

WITH expired_basis AS (
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-input-manifest@1',
    'period', '90D',
    'validUntil', '2020-01-01T00:00:00.000000Z',
    'inputs', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('pnl', 5)
    )
  ) AS basis
), expired_manifest AS (
  SELECT
    expired_basis.basis,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(expired_basis.basis::text, 'UTF8')
      ),
      'hex'
    ) AS digest
  FROM expired_basis
)
INSERT INTO arena.leaderboard_score_input_manifests (
  manifest_id, manifest_digest, period, manifest, valid_until, created_at
)
SELECT
  '44444444-4444-4444-8444-444444444444'::uuid,
  expired_manifest.digest,
  '90D',
  expired_manifest.basis || pg_catalog.jsonb_build_object(
    'manifestDigest', expired_manifest.digest
  ),
  '2020-01-01 00:00:00+00'::timestamptz,
  '2020-01-01 00:00:00+00'::timestamptz
FROM expired_manifest;
SQL

expect_failure \
  "manifest binding accepted an expired manifest" \
  "generation manifest binding requires a live manifest" \
  "INSERT INTO arena.leaderboard_rank_generation_manifest_bindings VALUES ('leaderboard-rank-generation-manifest-binding@1','90D',1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','44444444-4444-4444-8444-444444444444',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='44444444-4444-4444-8444-444444444444'),'2026-07-25 00:00:01+00');"
psql_cmd -q -c \
  "DELETE FROM arena.leaderboard_score_input_manifests WHERE manifest_id = '44444444-4444-4444-8444-444444444444';"

psql_cmd -q <<'SQL'

INSERT INTO arena.leaderboard_rank_generation_manifest_bindings (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  score_input_manifest_id,
  score_input_manifest_digest,
  bound_at
)
SELECT
  'leaderboard-rank-generation-manifest-binding@1',
  '7D',
  1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  stored.manifest_id,
  stored.manifest_digest,
  '2026-07-25 00:00:01+00'::timestamptz
FROM arena.leaderboard_score_input_manifests AS stored
WHERE stored.manifest_id =
  '11111111-1111-4111-8111-111111111111'::uuid;

INSERT INTO arena.leaderboard_rank_generation_batch_receipts (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  batch_index,
  batch_sha256,
  score_input_manifest_id,
  score_input_manifest_digest,
  row_count,
  source_count,
  first_source,
  first_source_trader_id,
  last_source,
  last_source_trader_id,
  completed_at
)
SELECT
  'leaderboard-rank-generation-batch-receipt@1',
  '7D',
  1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  0,
  pg_catalog.repeat('f', 64),
  stored.manifest_id,
  stored.manifest_digest,
  2,
  2,
  'binance',
  'alice',
  'okx',
  'bob',
  '2026-07-25 00:00:02+00'::timestamptz
FROM arena.leaderboard_score_input_manifests AS stored
WHERE stored.manifest_id =
  '11111111-1111-4111-8111-111111111111'::uuid;

INSERT INTO arena.leaderboard_rank_generation_source_fence_receipts (
  contract,
  season_id,
  generation_seq,
  batch_index,
  source,
  source_row_count,
  source_identity_sha256,
  mutation_seq_before,
  mutation_seq_after
) VALUES
  (
    'leaderboard-rank-generation-source-fence-receipt@1',
    '7D', 1, 0, 'binance', 1, pg_catalog.repeat('1', 64), 0, 1
  ),
  (
    'leaderboard-rank-generation-source-fence-receipt@1',
    '7D', 1, 0, 'okx', 1, pg_catalog.repeat('2', 64), 0, 1
  );
SQL

# Manifest identity, digest, and period are one composite authority. A batch
# must use the generation's one immutable binding; independent valid pieces
# from two manifests can never be spliced together.
expect_failure \
  "manifest binding accepted a cross-manifest digest" \
  "generation manifest binding does not match one stored manifest" \
  "INSERT INTO arena.leaderboard_rank_generation_manifest_bindings VALUES ('leaderboard-rank-generation-manifest-binding@1','30D',1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='33333333-3333-4333-8333-333333333333'),'2026-07-25 00:00:03+00');"
expect_failure \
  "manifest binding accepted a cross-period manifest" \
  "generation manifest binding does not match one stored manifest" \
  "INSERT INTO arena.leaderboard_rank_generation_manifest_bindings VALUES ('leaderboard-rank-generation-manifest-binding@1','30D',1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='11111111-1111-4111-8111-111111111111'),'2026-07-25 00:00:03+00');"

psql_cmd -q -c \
  "UPDATE arena.leaderboard_score_input_manifests SET manifest = manifest || jsonb_build_object('tampered', true) WHERE manifest_id = '22222222-2222-4222-8222-222222222222';"
expect_failure \
  "manifest binding accepted content outside its digest" \
  "generation manifest binding found invalid content addressing" \
  "INSERT INTO arena.leaderboard_rank_generation_manifest_bindings VALUES ('leaderboard-rank-generation-manifest-binding@1','30D',1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='22222222-2222-4222-8222-222222222222'),'2026-07-25 00:00:03+00');"
psql_cmd -q -c \
  "UPDATE arena.leaderboard_score_input_manifests SET manifest = manifest - 'tampered' WHERE manifest_id = '22222222-2222-4222-8222-222222222222';"

psql_cmd -q -c \
  "INSERT INTO arena.leaderboard_rank_generation_manifest_bindings VALUES ('leaderboard-rank-generation-manifest-binding@1','30D',1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='22222222-2222-4222-8222-222222222222'),'2026-07-25 00:00:03+00');"
expect_failure \
  "batch accepted a different valid generation manifest" \
  "rank_generation_batch_receipt_binding_fkey" \
  "INSERT INTO arena.leaderboard_rank_generation_batch_receipts VALUES ('leaderboard-rank-generation-batch-receipt@1','30D',1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',0,repeat('3',64),'33333333-3333-4333-8333-333333333333',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='33333333-3333-4333-8333-333333333333'),1,1,'binance','alice','binance','alice','2026-07-25 00:00:04+00');"

expect_failure \
  "single-row batch accepted different endpoints" \
  "rank_generation_batch_receipt_identity_order_check" \
  "INSERT INTO arena.leaderboard_rank_generation_batch_receipts VALUES ('leaderboard-rank-generation-batch-receipt@1','30D',1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',0,repeat('4',64),'22222222-2222-4222-8222-222222222222',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='22222222-2222-4222-8222-222222222222'),1,1,'binance','alice','binance','bob','2026-07-25 00:00:04+00');"
expect_failure \
  "multi-row batch accepted equal endpoints" \
  "rank_generation_batch_receipt_identity_order_check" \
  "INSERT INTO arena.leaderboard_rank_generation_batch_receipts VALUES ('leaderboard-rank-generation-batch-receipt@1','30D',1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',0,repeat('5',64),'22222222-2222-4222-8222-222222222222',(SELECT manifest_digest FROM arena.leaderboard_score_input_manifests WHERE manifest_id='22222222-2222-4222-8222-222222222222'),2,1,'binance','alice','binance','alice','2026-07-25 00:00:04+00');"

# The validator's FOR SHARE lock closes the verify/bind TOCTOU window. A
# concurrent payload delete must wait until the binding transaction commits;
# after commit, pruning succeeds because no permanent FK pins the payload.
psql_cmd -q <<'SQL'
SET ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '90D',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  pg_catalog.repeat('c', 64),
  1,
  1,
  '2026-07-25 00:00:00+00'::timestamptz,
  300
);
RESET ROLE;

WITH live_basis AS (
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-input-manifest@1',
    'period', '90D',
    'validUntil', '2099-01-01T00:00:00.000000Z',
    'inputs', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('pnl', 6)
    )
  ) AS basis
), live_manifest AS (
  SELECT
    live_basis.basis,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(live_basis.basis::text, 'UTF8')
      ),
      'hex'
    ) AS digest
  FROM live_basis
)
INSERT INTO arena.leaderboard_score_input_manifests (
  manifest_id, manifest_digest, period, manifest, valid_until, created_at
)
SELECT
  '44444444-4444-4444-8444-444444444444'::uuid,
  live_manifest.digest,
  '90D',
  live_manifest.basis || pg_catalog.jsonb_build_object(
    'manifestDigest', live_manifest.digest
  ),
  '2099-01-01 00:00:00+00'::timestamptz,
  '2026-07-25 00:00:00+00'::timestamptz
FROM live_manifest;
SQL

LOCK_SESSION_LOG="$TMP_ROOT/manifest-binding-lock.log"
psql_cmd -q >"$LOCK_SESSION_LOG" 2>&1 <<'SQL' &
SET application_name = 'receipt_binding_lock_holder';
BEGIN;
INSERT INTO arena.leaderboard_rank_generation_manifest_bindings (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  score_input_manifest_id,
  score_input_manifest_digest,
  bound_at
)
SELECT
  'leaderboard-rank-generation-manifest-binding@1',
  '90D',
  1,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  stored.manifest_id,
  stored.manifest_digest,
  '2026-07-25 00:00:05+00'::timestamptz
FROM arena.leaderboard_score_input_manifests AS stored
WHERE stored.manifest_id =
  '44444444-4444-4444-8444-444444444444'::uuid;
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
LOCK_HOLDER_PID=$!
LOCK_READY=false
for _ in {1..40}; do
  if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE application_name='receipt_binding_lock_holder' AND state='active' AND query LIKE '%pg_sleep%');")" == "t" ]]; then
    LOCK_READY=true
    break
  fi
  sleep 0.05
done
if [[ "$LOCK_READY" != "true" ]]; then
  echo "manifest binding lock holder never reached the guarded window" >&2
  sed -n '1,160p' "$LOCK_SESSION_LOG" >&2 || true
  exit 1
fi
expect_failure \
  "manifest payload delete bypassed binding lock" \
  "canceling statement due to lock timeout" \
  "SET lock_timeout = '200ms'; DELETE FROM arena.leaderboard_score_input_manifests WHERE manifest_id = '44444444-4444-4444-8444-444444444444';"
if ! wait "$LOCK_HOLDER_PID"; then
  echo "manifest binding lock holder failed" >&2
  sed -n '1,160p' "$LOCK_SESSION_LOG" >&2 || true
  exit 1
fi
psql_cmd -q -c \
  "DELETE FROM arena.leaderboard_score_input_manifests WHERE manifest_id = '44444444-4444-4444-8444-444444444444';"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM arena.leaderboard_rank_generation_manifest_bindings WHERE season_id='90D' AND generation_seq=1;")" != "1" ]]; then
  echo "manifest pruning lost the concurrently committed compact binding" >&2
  exit 1
fi

# Binding stores compact durable identity evidence, not a permanent FK to the
# potentially 64 MiB payload. Expired/full manifests can be pruned later while
# immutable generation and batch evidence remain queryable.
psql_cmd -q -c \
  "DELETE FROM arena.leaderboard_score_input_manifests WHERE manifest_id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');"
if [[ "$(psql_cmd -Atqc "SELECT (SELECT count(*) FROM arena.leaderboard_score_input_manifests) || '|' || (SELECT count(*) FROM arena.leaderboard_rank_generation_manifest_bindings) || '|' || (SELECT count(*) FROM arena.leaderboard_rank_generation_batch_receipts);")" != "1|3|1" ]]; then
  echo "manifest pruning removed compact generation evidence" >&2
  exit 1
fi

expect_failure \
  "source receipt accepted zero fence movement" \
  "rank_generation_source_fence_receipt_mutation_window_check" \
  "INSERT INTO arena.leaderboard_rank_generation_source_fence_receipts VALUES ('leaderboard-rank-generation-source-fence-receipt@1','7D',1,0,'bybit',1,repeat('6',64),1,1);"
expect_failure \
  "source receipt accepted three fence movements" \
  "rank_generation_source_fence_receipt_mutation_window_check" \
  "INSERT INTO arena.leaderboard_rank_generation_source_fence_receipts VALUES ('leaderboard-rank-generation-source-fence-receipt@1','7D',1,0,'bybit',1,repeat('6',64),1,4);"
expect_failure \
  "source receipt accepted an unknown fence identity" \
  "rank_generation_source_fence_receipt_fence_fkey" \
  "INSERT INTO arena.leaderboard_rank_generation_source_fence_receipts VALUES ('leaderboard-rank-generation-source-fence-receipt@1','7D',1,0,'gmx',1,repeat('6',64),0,1);"

for table_name in \
  leaderboard_rank_generation_manifest_bindings \
  leaderboard_rank_generation_batch_receipts \
  leaderboard_rank_generation_source_fence_receipts; do
  expect_failure \
    "service read $table_name" \
    "permission denied for table $table_name" \
    "SET ROLE service_role; SELECT * FROM arena.$table_name;"
  expect_failure \
    "service write $table_name" \
    "permission denied for table $table_name" \
    "SET ROLE service_role; INSERT INTO arena.$table_name DEFAULT VALUES;"
done

expect_failure \
  "manifest binding update" \
  "leaderboard publication receipts are immutable" \
  "UPDATE arena.leaderboard_rank_generation_manifest_bindings SET bound_at = bound_at WHERE season_id = '7D';"
expect_failure \
  "manifest binding delete" \
  "leaderboard publication receipts are immutable" \
  "DELETE FROM arena.leaderboard_rank_generation_manifest_bindings WHERE season_id = '7D';"
expect_failure \
  "batch receipt update" \
  "leaderboard publication receipts are immutable" \
  "UPDATE arena.leaderboard_rank_generation_batch_receipts SET row_count = row_count WHERE season_id = '7D';"
expect_failure \
  "batch receipt delete" \
  "leaderboard publication receipts are immutable" \
  "DELETE FROM arena.leaderboard_rank_generation_batch_receipts WHERE season_id = '7D';"
expect_failure \
  "source receipt update" \
  "leaderboard publication receipts are immutable" \
  "UPDATE arena.leaderboard_rank_generation_source_fence_receipts SET source_row_count = source_row_count WHERE season_id = '7D';"
expect_failure \
  "source receipt delete" \
  "leaderboard publication receipts are immutable" \
  "DELETE FROM arena.leaderboard_rank_generation_source_fence_receipts WHERE season_id = '7D';"
expect_failure \
  "source receipt truncate" \
  "leaderboard publication receipts are immutable" \
  "TRUNCATE arena.leaderboard_rank_generation_source_fence_receipts;"
expect_failure \
  "batch receipt truncate" \
  "leaderboard publication receipts are immutable" \
  "TRUNCATE arena.leaderboard_rank_generation_source_fence_receipts, arena.leaderboard_rank_generation_batch_receipts;"
expect_failure \
  "manifest binding truncate" \
  "leaderboard publication receipts are immutable" \
  "TRUNCATE arena.leaderboard_rank_generation_source_fence_receipts, arena.leaderboard_rank_generation_batch_receipts, arena.leaderboard_rank_generation_manifest_bindings;"

RECEIPT_OBJECTS_BEFORE="$(psql_cmd -Atqc "
  WITH objects AS (
    SELECT 'table'::text AS kind, table_row.oid, table_row.relname AS name
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid IN (
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'index', index_row.indexrelid, index_class.relname
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_row.indexrelid
    WHERE index_row.indrelid IN (
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'constraint', constraint_row.oid, constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'trigger', trigger_row.oid, trigger_row.tgname
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'function', function_row.oid, function_row.proname
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'arena.validate_leaderboard_rank_generation_manifest_binding()'
        ::regprocedure
  )
  SELECT encode(
    sha256(convert_to(string_agg(kind || '|' || name || '|' || oid, E'\\n' ORDER BY kind, name, oid), 'UTF8')),
    'hex'
  )
  FROM objects;
")"
RECEIPT_ROWS_BEFORE="$(psql_cmd -Atqc "
  WITH receipt_rows AS (
    SELECT
      'binding'::text AS kind,
      tableoid::text AS table_oid,
      xmin::text AS row_xmin,
      ctid::text AS row_ctid,
      pg_catalog.to_jsonb(binding)::text AS body
    FROM arena.leaderboard_rank_generation_manifest_bindings AS binding
    UNION ALL
    SELECT
      'batch', tableoid::text, xmin::text, ctid::text,
      pg_catalog.to_jsonb(batch)::text
    FROM arena.leaderboard_rank_generation_batch_receipts AS batch
    UNION ALL
    SELECT
      'source', tableoid::text, xmin::text, ctid::text,
      pg_catalog.to_jsonb(source_receipt)::text
    FROM arena.leaderboard_rank_generation_source_fence_receipts AS source_receipt
  )
  SELECT encode(
    sha256(convert_to(string_agg(kind || '|' || table_oid || '|' || row_xmin || '|' || row_ctid || '|' || body, E'\\n' ORDER BY kind, body), 'UTF8')),
    'hex'
  )
  FROM receipt_rows;
")"
SEQUENCE_COUNT_BEFORE="$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_class WHERE relkind = 'S';")"

psql_cmd -q -f "$RECEIPT_MIGRATION"

RECEIPT_OBJECTS_AFTER="$(psql_cmd -Atqc "
  WITH objects AS (
    SELECT 'table'::text AS kind, table_row.oid, table_row.relname AS name
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid IN (
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'index', index_row.indexrelid, index_class.relname
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_row.indexrelid
    WHERE index_row.indrelid IN (
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'constraint', constraint_row.oid, constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'trigger', trigger_row.oid, trigger_row.tgname
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
    UNION ALL
    SELECT 'function', function_row.oid, function_row.proname
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'arena.validate_leaderboard_rank_generation_manifest_binding()'
        ::regprocedure
  )
  SELECT encode(
    sha256(convert_to(string_agg(kind || '|' || name || '|' || oid, E'\\n' ORDER BY kind, name, oid), 'UTF8')),
    'hex'
  )
  FROM objects;
")"
RECEIPT_ROWS_AFTER="$(psql_cmd -Atqc "
  WITH receipt_rows AS (
    SELECT
      'binding'::text AS kind,
      tableoid::text AS table_oid,
      xmin::text AS row_xmin,
      ctid::text AS row_ctid,
      pg_catalog.to_jsonb(binding)::text AS body
    FROM arena.leaderboard_rank_generation_manifest_bindings AS binding
    UNION ALL
    SELECT
      'batch', tableoid::text, xmin::text, ctid::text,
      pg_catalog.to_jsonb(batch)::text
    FROM arena.leaderboard_rank_generation_batch_receipts AS batch
    UNION ALL
    SELECT
      'source', tableoid::text, xmin::text, ctid::text,
      pg_catalog.to_jsonb(source_receipt)::text
    FROM arena.leaderboard_rank_generation_source_fence_receipts AS source_receipt
  )
  SELECT encode(
    sha256(convert_to(string_agg(kind || '|' || table_oid || '|' || row_xmin || '|' || row_ctid || '|' || body, E'\\n' ORDER BY kind, body), 'UTF8')),
    'hex'
  )
  FROM receipt_rows;
")"
if [[ "$RECEIPT_OBJECTS_BEFORE" != "$RECEIPT_OBJECTS_AFTER" ]] \
   || [[ "$RECEIPT_ROWS_BEFORE" != "$RECEIPT_ROWS_AFTER" ]] \
   || [[ "$SEQUENCE_COUNT_BEFORE" != "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_class WHERE relkind = 'S';")" ]]; then
  echo "receipt replay changed object identity, physical rows, or sequences" >&2
  exit 1
fi

# Replay is an attestation, never a repair path. Each hostile catalog change
# must remain visible after the expected transactional failure.
psql_cmd -q -c \
  'GRANT SELECT ON arena.leaderboard_rank_generation_batch_receipts TO fixture_rogue;'
expect_receipt_migration_failure \
  "receipt replay accepted a rogue grant" \
  "generation receipt table owner, RLS, ACL, inheritance, rule, or policy postflight failed"
if [[ "$(psql_cmd -Atqc "SELECT has_table_privilege('fixture_rogue','arena.leaderboard_rank_generation_batch_receipts','SELECT');")" != "t" ]]; then
  echo "receipt replay silently repaired a rogue grant" >&2
  exit 1
fi
psql_cmd -q -c \
  'REVOKE SELECT ON arena.leaderboard_rank_generation_batch_receipts FROM fixture_rogue;'

psql_cmd -q -c \
  'GRANT EXECUTE ON FUNCTION arena.validate_leaderboard_rank_generation_manifest_binding() TO fixture_rogue;'
expect_receipt_migration_failure \
  "receipt replay accepted a validator function grant" \
  "generation manifest binding validator drifted"
if [[ "$(psql_cmd -Atqc "SELECT has_function_privilege('fixture_rogue','arena.validate_leaderboard_rank_generation_manifest_binding()','EXECUTE');")" != "t" ]]; then
  echo "validator replay silently repaired a rogue grant" >&2
  exit 1
fi
psql_cmd -q -c \
  'REVOKE EXECUTE ON FUNCTION arena.validate_leaderboard_rank_generation_manifest_binding() FROM fixture_rogue;'

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_manifest_bindings DISABLE TRIGGER leaderboard_rank_generation_manifest_bindings_validate;'
expect_receipt_migration_failure \
  "receipt replay accepted a disabled manifest validator" \
  "generation receipt immutable trigger contract drifted"
psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_manifest_bindings ENABLE TRIGGER leaderboard_rank_generation_manifest_bindings_validate;'

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_batch_receipts ADD CONSTRAINT fixture_receipt_extra_check CHECK (row_count > 0);'
expect_receipt_migration_failure \
  "receipt replay accepted an extra constraint" \
  "generation receipt constraint counts drifted"
psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_batch_receipts DROP CONSTRAINT fixture_receipt_extra_check;'

psql_cmd -q -c \
  'CREATE INDEX fixture_receipt_extra_index ON arena.leaderboard_rank_generation_batch_receipts (completed_at);'
expect_receipt_migration_failure \
  "receipt replay accepted an extra index" \
  "generation receipt index counts drifted"
psql_cmd -q -c 'DROP INDEX arena.fixture_receipt_extra_index;'

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_source_fence_receipts ALTER COLUMN source_row_count SET DEFAULT 1;'
expect_receipt_migration_failure \
  "receipt replay accepted a new column default" \
  "generation receipt column contract postflight failed"
psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_source_fence_receipts ALTER COLUMN source_row_count DROP DEFAULT;'

psql_cmd -q <<'SQL'
DROP TRIGGER leaderboard_rank_generation_batch_receipts_immutable
  ON arena.leaderboard_rank_generation_batch_receipts;
CREATE TRIGGER leaderboard_rank_generation_batch_receipts_immutable
BEFORE UPDATE OF row_count OR DELETE
ON arena.leaderboard_rank_generation_batch_receipts
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();
SQL
expect_receipt_migration_failure \
  "receipt replay accepted a column-restricted immutable trigger" \
  "generation receipt immutable trigger contract drifted"
psql_cmd -q <<'SQL'
DROP TRIGGER leaderboard_rank_generation_batch_receipts_immutable
  ON arena.leaderboard_rank_generation_batch_receipts;
CREATE TRIGGER leaderboard_rank_generation_batch_receipts_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_generation_batch_receipts
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();
SQL

psql_cmd -q <<'SQL'
DO $disable_fk_trigger$
DECLARE
  v_trigger_name name;
BEGIN
  SELECT trigger_row.tgname
  INTO STRICT v_trigger_name
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = trigger_row.tgfoid
  WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_generation_batch_receipts'::regclass
    AND trigger_row.tgconstraint = (
      SELECT constraint_row.oid
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          'arena.leaderboard_rank_generation_batch_receipts'::regclass
        AND constraint_row.conname =
          'rank_generation_batch_receipt_binding_fkey'
    )
    AND function_row.proname = 'RI_FKey_check_ins';
  EXECUTE pg_catalog.format(
    'ALTER TABLE arena.leaderboard_rank_generation_batch_receipts DISABLE TRIGGER %I',
    v_trigger_name
  );
END
$disable_fk_trigger$;
SQL
expect_receipt_migration_failure \
  "receipt replay accepted a disabled FK trigger" \
  "generation receipt foreign-key trigger contract drifted"
psql_cmd -q <<'SQL'
DO $enable_fk_trigger$
DECLARE
  v_trigger_name name;
BEGIN
  SELECT trigger_row.tgname
  INTO STRICT v_trigger_name
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = trigger_row.tgfoid
  WHERE trigger_row.tgrelid =
      'arena.leaderboard_rank_generation_batch_receipts'::regclass
    AND trigger_row.tgconstraint = (
      SELECT constraint_row.oid
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          'arena.leaderboard_rank_generation_batch_receipts'::regclass
        AND constraint_row.conname =
          'rank_generation_batch_receipt_binding_fkey'
    )
    AND function_row.proname = 'RI_FKey_check_ins';
  EXECUTE pg_catalog.format(
    'ALTER TABLE arena.leaderboard_rank_generation_batch_receipts ENABLE TRIGGER %I',
    v_trigger_name
  );
END
$enable_fk_trigger$;
SQL

psql_cmd -q -c \
  'CREATE POLICY fixture_receipt_policy ON arena.leaderboard_rank_generation_batch_receipts FOR SELECT USING (true);'
expect_receipt_migration_failure \
  "receipt replay accepted a rogue policy" \
  "generation receipt table owner, RLS, ACL, inheritance, rule, or policy postflight failed"
psql_cmd -q -c \
  'DROP POLICY fixture_receipt_policy ON arena.leaderboard_rank_generation_batch_receipts;'

CONSTRAINT_DIGEST="$(psql_cmd -Atqc "
  SELECT encode(
    sha256(
      convert_to(
        string_agg(
          format(
            '%s|%s|%s|%s|%s|%s|%s|%s|%s',
            table_row.relname,
            constraint_row.conname,
            constraint_row.contype,
            constraint_row.convalidated,
            constraint_row.condeferrable,
            constraint_row.condeferred,
            constraint_row.connoinherit,
            constraint_row.conkey::text,
            pg_get_constraintdef(constraint_row.oid, true)
          ),
          E'\\n' ORDER BY table_row.relname, constraint_row.conname
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = constraint_row.conrelid
  WHERE constraint_row.conrelid IN (
    'arena.leaderboard_score_input_manifests'::regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  );
")"
INDEX_DIGEST="$(psql_cmd -Atqc "
  SELECT encode(
    sha256(
      convert_to(
        string_agg(
          format(
            '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
            table_row.relname,
            index_class.relname,
            index_row.indisunique,
            index_row.indisprimary,
            index_row.indisvalid,
            index_row.indisready,
            index_row.indislive,
            index_row.indimmediate,
            index_row.indisclustered,
            index_row.indisreplident,
            index_row.indnkeyatts,
            index_row.indnatts,
            index_row.indkey::text,
            pg_get_indexdef(index_row.indexrelid)
          ),
          E'\\n' ORDER BY table_row.relname, index_class.relname
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = index_row.indrelid
  JOIN pg_catalog.pg_class AS index_class
    ON index_class.oid = index_row.indexrelid
  WHERE index_row.indrelid IN (
    'arena.leaderboard_score_input_manifests'::regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  );
")"
echo "receipt constraint digest: $CONSTRAINT_DIGEST"
echo "receipt index digest: $INDEX_DIGEST"

if [[ "$CONSTRAINT_DIGEST" != "7b42ceb84f6d85497dcf699c6eac27220eb3ce340926619477f07a56bd00d28b" ]] \
   || [[ "$INDEX_DIGEST" != "b221a4e29bf6278f35045aec56e8c8509d86ae60ac62f5aa3f57fbceb819a6eb" ]]; then
  echo "receipt catalog digest drifted" >&2
  exit 1
fi

echo "leaderboard rank generation receipt substrate PG17 proof passed"
