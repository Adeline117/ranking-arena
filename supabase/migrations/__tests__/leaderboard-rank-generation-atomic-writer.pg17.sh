#!/usr/bin/env bash

# PostgreSQL 17 end-to-end proof for the dormant, owner-only atomic typed
# leaderboard-rank batch writer. The fixture deliberately installs every real
# production dependency in migration order. It then proves a two-batch mixed
# insert/update write, failures after physical DML that roll the complete
# transaction back, and receipt-backed zero-write replay after lease expiry,
# manifest pruning, terminal head state, and legacy rank drift. Setting
# ARENA_ATOMIC_WRITER_BENCHMARK_64K=1 reuses the exact dependency bootstrap but
# runs the durable 64k/64-batch release-capacity gate instead of the small proof.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FOUNDATION="$ROOT_DIR/supabase/migrations/__tests__/fixtures/leaderboard-rank-atomic-writer-foundation.pg17.inc"
SCORER_MIGRATION="$ROOT_DIR/supabase/migrations/20260722041000_pure_arena_score_v4_scorer.sql"
MANIFEST_MIGRATION="$ROOT_DIR/supabase/migrations/20260722051000_leaderboard_score_input_manifest_contract.sql"
PNL_MIGRATION="$ROOT_DIR/supabase/migrations/20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql"
MUTATION_MIGRATION="$ROOT_DIR/supabase/migrations/20260724235000_leaderboard_publication_mutation_fence.sql"
CLAIM_MIGRATION="$ROOT_DIR/supabase/migrations/20260725015000_leaderboard_rank_generation_claim.sql"
CAPACITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260725015500_bound_leaderboard_rank_generation_batches.sql"
RECEIPT_MIGRATION="$ROOT_DIR/supabase/migrations/20260725016000_leaderboard_rank_generation_receipt_substrate.sql"
CODEC_MIGRATION="$ROOT_DIR/supabase/migrations/20260725016500_leaderboard_rank_persisted_codec.sql"
TYPED_MIGRATION="$ROOT_DIR/supabase/migrations/20260725017000_leaderboard_rank_typed_batch_contract.sql"
MDD_MIGRATION="$ROOT_DIR/supabase/migrations/20260725017250_normalize_leaderboard_rank_max_drawdown.sql"
WRITER_MIGRATION="$ROOT_DIR/supabase/migrations/20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql"
ATTESTATION_MIGRATION="$ROOT_DIR/supabase/migrations/20260729011000_leaderboard_rank_manifest_attestation_substrate.sql"
CANONICAL_BATCH_MIGRATION="$ROOT_DIR/supabase/migrations/20260729014500_leaderboard_rank_generation_canonical_batches.sql"
ATTESTED_WRITER_MIGRATION="$ROOT_DIR/supabase/migrations/20260729015000_leaderboard_rank_generation_attested_batch_writer.sql"
CAPACITY_BENCHMARK="$ROOT_DIR/supabase/migrations/__tests__/fixtures/leaderboard-rank-generation-64k-benchmark.pg17.psql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
BENCHMARK_64K="${ARENA_ATOMIC_WRITER_BENCHMARK_64K:-0}"
BENCHMARK_SCENARIO="${ARENA_ATOMIC_WRITER_BENCHMARK_SCENARIO:-insert}"

if [[ "$BENCHMARK_64K" != '0' && "$BENCHMARK_64K" != '1' ]]; then
  echo 'ARENA_ATOMIC_WRITER_BENCHMARK_64K must be 0 or 1' >&2
  exit 1
fi
if [[ "$BENCHMARK_SCENARIO" != 'insert' && "$BENCHMARK_SCENARIO" != 'update' ]]; then
  echo 'ARENA_ATOMIC_WRITER_BENCHMARK_SCENARIO must be insert or update' >&2
  exit 1
fi

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
for required_file in \
  "$FOUNDATION" \
  "$SCORER_MIGRATION" \
  "$MANIFEST_MIGRATION" \
  "$PNL_MIGRATION" \
  "$MUTATION_MIGRATION" \
  "$CLAIM_MIGRATION" \
  "$CAPACITY_MIGRATION" \
  "$RECEIPT_MIGRATION" \
  "$CODEC_MIGRATION" \
  "$TYPED_MIGRATION" \
  "$MDD_MIGRATION" \
  "$WRITER_MIGRATION" \
  "$ATTESTATION_MIGRATION" \
  "$CANONICAL_BATCH_MIGRATION" \
  "$ATTESTED_WRITER_MIGRATION" \
  "$CAPACITY_BENCHMARK"; do
  if [[ ! -f "$required_file" ]]; then
    echo "required atomic-writer proof input is missing: $required_file" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/rank-atomic-writer-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((62000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -260 "$LOG_FILE" >&2 || true
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
    sed -n '1,240p' "$ERROR_FILE" >&2
    exit 1
  fi
}

wait_for_sql_true() {
  local label="$1"
  local sql="$2"
  local attempt
  for ((attempt = 0; attempt < 200; attempt += 1)); do
    if [[ "$(psql_cmd -Atqc "$sql")" == 't' ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "$label did not reach the required lock state" >&2
  return 1
}

capture_atomic_state() {
  local include_rank_sequence="${1:-true}"
  psql_cmd -Atq -v include_rank_sequence="$include_rank_sequence" <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'ranks', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(rank_row)
              ORDER BY
                rank_row.season_id COLLATE pg_catalog."C",
                rank_row.source COLLATE pg_catalog."C",
                rank_row.source_trader_id COLLATE pg_catalog."C"
            )
            FROM public.leaderboard_ranks AS rank_row
          ),
          '[]'::jsonb
        ),
        'claim', (
          SELECT pg_catalog.to_jsonb(claim)
          FROM ONLY arena.leaderboard_rank_generation_claims AS claim
          WHERE claim.season_id = '90D'
        ),
        'head', (
          SELECT pg_catalog.to_jsonb(head)
          FROM ONLY arena.leaderboard_rank_generation_heads AS head
          WHERE head.season_id = '90D'
        ),
        'manifests', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(manifest)
              ORDER BY manifest.manifest_id
            )
            FROM ONLY arena.leaderboard_score_input_manifests AS manifest
          ),
          '[]'::jsonb
        ),
        'bindings', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(binding)
              ORDER BY binding.season_id COLLATE pg_catalog."C",
                       binding.generation_seq
            )
            FROM ONLY arena.leaderboard_rank_generation_manifest_bindings
              AS binding
          ),
          '[]'::jsonb
        ),
        'manifestAttestations', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(header)
              ORDER BY header.season_id COLLATE pg_catalog."C",
                       header.generation_seq
            )
            FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
          ),
          '[]'::jsonb
        ),
        'manifestAttestationChunks', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(chunk)
              ORDER BY chunk.season_id COLLATE pg_catalog."C",
                       chunk.generation_seq,
                       chunk.chunk_index
            )
            FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks
              AS chunk
          ),
          '[]'::jsonb
        ),
        'batchReceipts', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(receipt)
              ORDER BY receipt.season_id COLLATE pg_catalog."C",
                       receipt.generation_seq,
                       receipt.batch_index
            )
            FROM ONLY arena.leaderboard_rank_generation_batch_receipts
              AS receipt
          ),
          '[]'::jsonb
        ),
        'sourceReceipts', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(source_receipt)
              ORDER BY source_receipt.season_id COLLATE pg_catalog."C",
                       source_receipt.generation_seq,
                       source_receipt.batch_index,
                       source_receipt.source COLLATE pg_catalog."C"
            )
            FROM ONLY
              arena.leaderboard_rank_generation_source_fence_receipts
                AS source_receipt
          ),
          '[]'::jsonb
        ),
        'fences', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.to_jsonb(fence)
              ORDER BY fence.season_id COLLATE pg_catalog."C",
                       fence.source COLLATE pg_catalog."C"
            )
            FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
          ),
          '[]'::jsonb
        ),
        'rankSequence', CASE
          WHEN :'include_rank_sequence'::boolean THEN (
            SELECT pg_catalog.jsonb_build_object(
              'lastValue', rank_sequence.last_value,
              'isCalled', rank_sequence.is_called
            )
            FROM public.leaderboard_ranks_id_seq AS rank_sequence
          )
          ELSE NULL::jsonb
        END
      )::text,
      'UTF8'
    )
  ),
  'hex'
);
SQL
}

replay_batch_zero() {
  psql_cmd -Atq <<'SQL'
SELECT arena.write_leaderboard_rank_generation_batch_v1(
  case_row.season_id,
  case_row.generation_seq,
  case_row.score_cohort_id,
  0,
  case_row.score_input_manifest_id,
  case_row.score_input_manifest_digest,
  case_row.batch_sha256_plan,
  case_row.batch_0_rows
)::text
FROM arena.fixture_atomic_writer_case AS case_row;
SQL
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
  --no-locale >/dev/null
if [[ "$BENCHMARK_64K" == '1' ]]; then
  POSTGRES_OPTIONS="-p $PORT -k $SOCKET_DIR -c listen_addresses= -c fsync=on -c synchronous_commit=on -c full_page_writes=on"
else
  POSTGRES_OPTIONS="-F -p $PORT -k $SOCKET_DIR -c listen_addresses="
fi
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "$POSTGRES_OPTIONS" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE fixture_rogue NOLOGIN;
CREATE SCHEMA arena;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA arena
  TO anon, authenticated, service_role, fixture_rogue;
SQL

psql_cmd -q -f "$FOUNDATION"
psql_cmd -q -f "$SCORER_MIGRATION"
psql_cmd -q -f "$MANIFEST_MIGRATION"

# 52000 is intentionally selective: install its exact immutable 51000 ledger
# evidence instead of weakening the forward migration in this standalone DB.
# Command substitution removes the checked-in newline, so restore it before
# passing the body through psql's literal variable binding.
psql_cmd -q -v migration_body="$(<"$MANIFEST_MIGRATION")"$'\n' <<'SQL'
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[] NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  idempotency_key text NOT NULL
);
INSERT INTO supabase_migrations.schema_migrations (
  version,
  statements,
  name,
  created_by,
  idempotency_key
) VALUES (
  '20260722051000',
  ARRAY[:'migration_body']::text[],
  'leaderboard_score_input_manifest_contract',
  'codex',
  'codex:20260722051000:fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'
);
SQL

psql_cmd -q -f "$PNL_MIGRATION"
psql_cmd -q -f "$MUTATION_MIGRATION"
psql_cmd -q -f "$CLAIM_MIGRATION"
psql_cmd -q -f "$CAPACITY_MIGRATION"
psql_cmd -q -f "$RECEIPT_MIGRATION"
psql_cmd -q -f "$CODEC_MIGRATION"
psql_cmd -q -f "$TYPED_MIGRATION"
psql_cmd -q -f "$MDD_MIGRATION"
if ! psql_cmd -q -f "$WRITER_MIGRATION" >"$ERROR_FILE" 2>&1; then
  echo 'atomic writer migration failed after the real dependency chain' >&2
  sed -n '1,240p' "$ERROR_FILE" >&2
  psql_cmd -Atq <<'SQL' >&2
SELECT
  expected.signature || '|' || COALESCE(
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(function_row.prosrc, 'UTF8')
      ),
      'hex'
    ),
    'missing'
  )
FROM (VALUES
  ('public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'),
  ('arena.validate_leaderboard_rank_generation_manifest_binding()'),
  ('arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'),
  ('arena.verify_leaderboard_score_input_manifest_v1(uuid)'),
  ('arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'),
  ('arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'),
  ('arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'),
  ('arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'),
  ('arena.bump_leaderboard_rank_insert_fences()'),
  ('arena.bump_leaderboard_rank_update_fences()'),
  ('arena.bump_leaderboard_rank_delete_fences()')
) AS expected(signature)
LEFT JOIN pg_catalog.pg_proc AS function_row
  ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
ORDER BY expected.signature COLLATE pg_catalog."C";
SQL
  exit 1
fi
psql_cmd -q -f "$ATTESTATION_MIGRATION"

# Canonical claim migration is fail-closed over historical rows. Seed a claim
# that the old 4096-batch envelope accepts, prove the upgrade is fully atomic,
# then remove only this deliberate fixture and install the real migration.
psql_cmd -q <<'SQL'
DO $seed_noncanonical_claim$
DECLARE
  v_claimed_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  INSERT INTO arena.leaderboard_rank_generation_claims (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    write_set_sha256,
    expected_rank_count,
    expected_batch_count,
    computed_at,
    lease_seconds,
    claimed_at,
    lease_expires_at
  ) VALUES (
    'leaderboard-rank-generation-claim@1',
    '7D',
    1,
    '11500000-0000-4150-8150-000000000003'::uuid,
    pg_catalog.repeat('3', 64),
    1001,
    3,
    v_claimed_at,
    300,
    v_claimed_at,
    v_claimed_at + interval '300 seconds'
  );
END
$seed_noncanonical_claim$;
SQL

CANONICAL_FAILURE_STATE_BEFORE="$(psql_cmd -Atqc "
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.encode(
     pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc,'UTF8')),
     'hex'
   ) FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid =
     'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure),
  (SELECT pg_catalog.pg_get_expr(
     constraint_row.conbin,
     constraint_row.conrelid,
     false
   ) FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
     'arena.leaderboard_rank_generation_claims'::regclass
     AND constraint_row.conname =
       'leaderboard_rank_generation_claims_batch_capacity_check'),
  (SELECT pg_catalog.count(*)
   FROM ONLY arena.leaderboard_rank_generation_claims AS claim
   WHERE claim.score_cohort_id =
     '11500000-0000-4150-8150-000000000003'::uuid)
);")"
CANONICAL_OLD_FIRST_BLOCKER_LOG="$TMP_ROOT/canonical-old-first-blocker.log"
CANONICAL_OLD_FIRST_CLAIM_LOG="$TMP_ROOT/canonical-old-first-claim.log"
CANONICAL_FAILURE_LOG="$TMP_ROOT/canonical-history-failure.log"
(
  psql_cmd -q >"$CANONICAL_OLD_FIRST_BLOCKER_LOG" 2>&1 <<'SQL' || true
SET application_name = 'canonical-old-first-advisory-blocker';
SELECT pg_catalog.pg_advisory_lock(91337, 11499);
SELECT pg_catalog.pg_sleep(30);
SQL
) &
CANONICAL_OLD_FIRST_BLOCKER_PID=$!

wait_for_sql_true \
  'old-first advisory blocker' \
  "SELECT EXISTS (
     SELECT 1 FROM pg_catalog.pg_stat_activity AS activity
     WHERE activity.application_name='canonical-old-first-advisory-blocker'
       AND activity.wait_event='PgSleep'
   );"

(
  psql_cmd -q >"$CANONICAL_OLD_FIRST_CLAIM_LOG" 2>&1 <<'SQL'
BEGIN;
SET LOCAL application_name = 'canonical-old-first-claim-race';
SET LOCAL ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '30D',
  '11500000-0000-4150-8150-000000000014'::uuid,
  pg_catalog.repeat('e',64),
  1001,
  3,
  pg_catalog.clock_timestamp(),
  300
);
RESET ROLE;
SELECT pg_catalog.pg_advisory_lock(91337, 11499);
ROLLBACK;
SQL
) &
CANONICAL_OLD_FIRST_CLAIM_PID=$!

wait_for_sql_true \
  'old claim transaction before canonical migration' \
  "SELECT EXISTS (
     SELECT 1
     FROM pg_catalog.pg_stat_activity AS activity
     WHERE activity.application_name='canonical-old-first-claim-race'
       AND activity.wait_event_type='Lock'
       AND activity.wait_event='advisory'
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_locks AS claims_lock
         WHERE claims_lock.pid=activity.pid
           AND claims_lock.relation=
                 'arena.leaderboard_rank_generation_claims'::regclass
           AND claims_lock.mode='RowExclusiveLock'
           AND claims_lock.granted
       )
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_locks AS head_lock
         WHERE head_lock.pid=activity.pid
           AND head_lock.relation=
                 'arena.leaderboard_rank_generation_heads'::regclass
           AND head_lock.mode='RowExclusiveLock'
           AND head_lock.granted
       )
   );"

(
  psql_cmd -q \
    -c "SET application_name = 'canonical-old-first-migration-race'" \
    -f "$CANONICAL_BATCH_MIGRATION"
) >"$CANONICAL_FAILURE_LOG" 2>&1 &
CANONICAL_OLD_FIRST_MIGRATION_PID=$!

wait_for_sql_true \
  'canonical migration behind old claim transaction' \
  "SELECT EXISTS (
     SELECT 1
     FROM pg_catalog.pg_stat_activity AS activity
     WHERE activity.application_name='canonical-old-first-migration-race'
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_locks AS claims_lock
         WHERE claims_lock.pid=activity.pid
           AND claims_lock.relation=
                 'arena.leaderboard_rank_generation_claims'::regclass
           AND claims_lock.mode='AccessExclusiveLock'
           AND NOT claims_lock.granted
       )
   );"

psql_cmd -q -c "
  SELECT pg_catalog.pg_terminate_backend(activity.pid)
  FROM pg_catalog.pg_stat_activity AS activity
  WHERE activity.application_name='canonical-old-first-advisory-blocker';
" >/dev/null
wait "$CANONICAL_OLD_FIRST_BLOCKER_PID"
if ! wait "$CANONICAL_OLD_FIRST_CLAIM_PID"; then
  echo 'old claim transaction failed before the canonical migration drained it' >&2
  sed -n '1,240p' "$CANONICAL_OLD_FIRST_CLAIM_LOG" >&2
  exit 1
fi
if wait "$CANONICAL_OLD_FIRST_MIGRATION_PID"; then
  echo 'canonical batch migration accepted a historical noncanonical claim' >&2
  exit 1
fi
if ! rg -q 'historical generation claim.*incompatible|canonical 1000-row chunks' \
  "$CANONICAL_FAILURE_LOG"; then
  echo 'canonical batch migration rejected history for an unexpected reason' >&2
  sed -n '1,240p' "$CANONICAL_FAILURE_LOG" >&2
  exit 1
fi
CANONICAL_FAILURE_STATE_AFTER="$(psql_cmd -Atqc "
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.encode(
     pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc,'UTF8')),
     'hex'
   ) FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid =
     'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure),
  (SELECT pg_catalog.pg_get_expr(
     constraint_row.conbin,
     constraint_row.conrelid,
     false
   ) FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
     'arena.leaderboard_rank_generation_claims'::regclass
     AND constraint_row.conname =
       'leaderboard_rank_generation_claims_batch_capacity_check'),
  (SELECT pg_catalog.count(*)
   FROM ONLY arena.leaderboard_rank_generation_claims AS claim
   WHERE claim.score_cohort_id =
     '11500000-0000-4150-8150-000000000003'::uuid)
);")"
if [[ "$CANONICAL_FAILURE_STATE_AFTER" != "$CANONICAL_FAILURE_STATE_BEFORE" ]]; then
  echo 'failed canonical batch migration changed RPC, constraint, or history' >&2
  exit 1
fi

psql_cmd -q <<'SQL'
ALTER TABLE arena.leaderboard_rank_generation_claims
  DISABLE TRIGGER leaderboard_rank_generation_claim_immutable;
DELETE FROM ONLY arena.leaderboard_rank_generation_claims
WHERE score_cohort_id = '11500000-0000-4150-8150-000000000003'::uuid;
ALTER TABLE arena.leaderboard_rank_generation_claims
  ENABLE TRIGGER leaderboard_rank_generation_claim_immutable;
SQL

# Exercise the migration-first side of the upgrade race with the real old RPC.
# A test-only event trigger pauses the first ALTER TABLE only after the
# migration owns its claims ACCESS EXCLUSIVE barrier. It observes the legacy
# RPC's one-way head-to-claims wait edge, then releases the migration. The
# migration must finish before the old in-flight insert is rejected by the new
# CHECK. If the migration also waited on heads, the observer detects the cycle.
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.fixture_pause_canonical_batch_upgrade()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_attempt integer;
  v_seen boolean := false;
BEGIN
  IF TG_TAG IS DISTINCT FROM 'ALTER TABLE'
     OR pg_catalog.current_setting('application_name') IS DISTINCT FROM
          'canonical-batch-migration-race'
     OR pg_catalog.current_setting(
          'arena.fixture_canonical_race',
          true
        ) IS DISTINCT FROM 'on' THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.fixture_canonical_race',
    'off',
    true
  );
  FOR v_attempt IN 1..500 LOOP
    PERFORM pg_catalog.pg_stat_clear_snapshot();
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_stat_activity AS rpc
      WHERE rpc.datname = pg_catalog.current_database()
        AND rpc.application_name = 'canonical-batch-legacy-claim-race'
        AND rpc.wait_event_type = 'Lock'
        AND pg_catalog.pg_backend_pid() = ANY(
              pg_catalog.pg_blocking_pids(rpc.pid)
            )
        AND pg_catalog.cardinality(
              pg_catalog.pg_blocking_pids(pg_catalog.pg_backend_pid())
            ) = 0
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_locks AS claims_lock
          WHERE claims_lock.pid = rpc.pid
            AND claims_lock.relation =
                  'arena.leaderboard_rank_generation_claims'::regclass
            AND claims_lock.mode = 'AccessShareLock'
            AND NOT claims_lock.granted
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_locks AS head_lock
          WHERE head_lock.pid = rpc.pid
            AND head_lock.relation =
                  'arena.leaderboard_rank_generation_heads'::regclass
            AND head_lock.mode = 'RowShareLock'
            AND head_lock.granted
        )
    ) INTO v_seen;
    EXIT WHEN v_seen;
    PERFORM pg_catalog.pg_sleep(0.01);
  END LOOP;

  IF NOT v_seen THEN
    RAISE EXCEPTION
      'canonical migration did not observe the one-way head-to-claims waiter'
      USING ERRCODE = '55000';
  END IF;
END
$body$;
CREATE EVENT TRIGGER fixture_pause_canonical_batch_upgrade
  ON ddl_command_start
  WHEN TAG IN ('ALTER TABLE')
  EXECUTE FUNCTION arena.fixture_pause_canonical_batch_upgrade();
SQL

CANONICAL_MIGRATION_LOG="$TMP_ROOT/canonical-migration-race.log"
CANONICAL_CLAIM_LOG="$TMP_ROOT/canonical-claim-race.log"
(
  psql_cmd -v VERBOSITY=verbose -q \
    -c "SET application_name = 'canonical-batch-migration-race'; SET arena.fixture_canonical_race = 'on'" \
    -f "$CANONICAL_BATCH_MIGRATION"
) >"$CANONICAL_MIGRATION_LOG" 2>&1 &
CANONICAL_MIGRATION_PID=$!

wait_for_sql_true \
  'canonical migration claims barrier' \
  "SELECT EXISTS (
     SELECT 1
     FROM pg_catalog.pg_stat_activity AS activity
     WHERE activity.application_name='canonical-batch-migration-race'
       AND pg_catalog.cardinality(
             pg_catalog.pg_blocking_pids(activity.pid)
           ) = 0
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_locks AS relation_lock
         WHERE relation_lock.pid=activity.pid
           AND relation_lock.relation=
                 'arena.leaderboard_rank_generation_claims'::regclass
           AND relation_lock.mode='AccessExclusiveLock'
           AND relation_lock.granted
       )
   );"

(
  psql_cmd -v VERBOSITY=verbose -q >"$CANONICAL_CLAIM_LOG" 2>&1 <<'SQL'
BEGIN;
SET LOCAL application_name = 'canonical-batch-legacy-claim-race';
SELECT head.season_id
FROM ONLY arena.leaderboard_rank_generation_heads AS head
WHERE head.season_id = '7D'
FOR UPDATE;
SET LOCAL ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '7D',
  '11500000-0000-4150-8150-000000000013'::uuid,
  pg_catalog.repeat('d',64),
  1001,
  3,
  pg_catalog.clock_timestamp(),
  300
);
COMMIT;
SQL
) &
CANONICAL_CLAIM_PID=$!

if ! wait "$CANONICAL_MIGRATION_PID"; then
  echo 'canonical migration deadlocked or failed in migration-first race' >&2
  sed -n '1,240p' "$CANONICAL_MIGRATION_LOG" >&2
  exit 1
fi
if wait "$CANONICAL_CLAIM_PID"; then
  echo 'legacy loose claim committed behind the canonical migration barrier' >&2
  exit 1
fi
if ! rg -q \
  'canonical 1000-row batches|batch_capacity_check|violates check constraint' \
  "$CANONICAL_CLAIM_LOG"; then
  echo 'legacy loose claim failed for an unexpected race outcome' >&2
  sed -n '1,240p' "$CANONICAL_CLAIM_LOG" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "
  SELECT pg_catalog.count(*)
  FROM ONLY arena.leaderboard_rank_generation_claims
  WHERE score_cohort_id='11500000-0000-4150-8150-000000000013'::uuid;
")" != '0' ]]; then
  echo 'legacy loose claim left history after the canonical migration race' >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DROP EVENT TRIGGER fixture_pause_canonical_batch_upgrade;
DROP FUNCTION arena.fixture_pause_canonical_batch_upgrade();
SQL

# Exact 1/1000/1001/64000 boundaries are admitted under service_role and each
# transaction rolls back; loose 0/0, 1001/3, and 1/64 plans fail before state.
for boundary in '1 1 1' '1000 1 2' '1001 2 3' '64000 64 4'; do
  read -r rank_count batch_count suffix <<<"$boundary"
  psql_cmd -q -v rank_count="$rank_count" -v batch_count="$batch_count" \
    -v suffix="$suffix" >/dev/null <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '7D',
  ('11500000-0000-4150-8150-' || pg_catalog.lpad(:'suffix', 12, '0'))::uuid,
  pg_catalog.repeat(:'suffix', 64),
  :'rank_count'::integer,
  :'batch_count'::integer,
  pg_catalog.clock_timestamp(),
  300
);
ROLLBACK;
SQL
done

expect_failure \
  'canonical claim accepted empty 0/0 plan' \
  'canonical 1000-row batches' \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('7D','11500000-0000-4150-8150-000000000010',repeat('a',64),0,0,clock_timestamp(),300);"
expect_failure \
  'canonical claim accepted loose 1001/3 plan' \
  'canonical 1000-row batches' \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('7D','11500000-0000-4150-8150-000000000011',repeat('b',64),1001,3,clock_timestamp(),300);"
expect_failure \
  'canonical claim accepted one row split into 64 batches' \
  'canonical 1000-row batches' \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('7D','11500000-0000-4150-8150-000000000012',repeat('c',64),1,64,clock_timestamp(),300);"

if ! psql_cmd -q -f "$ATTESTED_WRITER_MIGRATION" >"$ERROR_FILE" 2>&1; then
  echo 'attested atomic writer migration failed after the real dependency chain' >&2
  sed -n '1,280p' "$ERROR_FILE" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
DO $attestation_encoder_proof$
DECLARE
  v_commitment text;
  v_factor_commitment_a text;
  v_factor_commitment_b text;
  v_rejected boolean := false;
BEGIN
  v_commitment := arena.build_leaderboard_rank_manifest_field_commitment_v1(
    'fixture',
    'trader-1',
    12.3456,
    1234.56,
    55.50,
    12.25,
    1.2500,
    1.5000,
    30,
    75.25,
    '{"roi":0.6,"pnl":0.7,"drawdown":0.8,"sharpe":0.9,"consistency":null}'::jsonb,
    66,
    85,
    NULL
  );
  IF v_commitment !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'manifest field commitment shape drifted';
  END IF;

  v_factor_commitment_a :=
    arena.build_leaderboard_rank_manifest_field_commitment_v1(
      'fixture', 'factor-a', 1, 1, 50, 10, NULL, NULL, NULL, 50,
      '{"roi":0.1,"pnl":0.2,"drawdown":null,"sharpe":null,"consistency":null}'::jsonb,
      16, 0, NULL
    );
  v_factor_commitment_b :=
    arena.build_leaderboard_rank_manifest_field_commitment_v1(
      'fixture', 'factor-a', 1, 1, 50, 10, NULL, NULL, NULL, 50,
      '{"roi":0.1000000000000000000000000001,"pnl":0.2,"drawdown":null,"sharpe":null,"consistency":null}'::jsonb,
      16, 0, NULL
    );
  IF v_factor_commitment_a = v_factor_commitment_b THEN
    RAISE EXCEPTION 'manifest factor precision collapsed before commitment';
  END IF;

  BEGIN
    PERFORM arena.build_leaderboard_rank_manifest_field_commitment_v1(
      'fixture', 'rounding-bypass', 1, 1, 50, 10, NULL, NULL, NULL,
      100.004,
      '{"roi":0.1,"pnl":0.2,"drawdown":null,"sharpe":null,"consistency":null}'::jsonb,
      16, 0, NULL
    );
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'manifest raw numeric rounding bypass was accepted';
  END IF;
END
$attestation_encoder_proof$;
SQL
ATTESTATION_FUNCTION_STATE="$(psql_cmd -Atq <<'SQL'
SELECT
  function_row.proname || '|' ||
  pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
FROM pg_catalog.pg_proc AS function_row
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.oid = function_row.pronamespace
WHERE namespace_row.nspname = 'arena'
  AND function_row.proname IN (
    'encode_leaderboard_rank_manifest_fields_v1',
    'build_leaderboard_rank_manifest_field_commitment_v1',
    'build_leaderboard_rank_manifest_chunk_sha256_v1',
    'leaderboard_rank_manifest_attestation_chunk_is_valid_v1',
    'build_leaderboard_rank_manifest_chunks_sha256_v1',
    'guard_leaderboard_rank_manifest_attestation_chunk_insert_v1',
    'validate_leaderboard_rank_manifest_attestation_complete_v1'
  )
ORDER BY function_row.proname COLLATE pg_catalog."C";
SQL
)"
EXPECTED_ATTESTATION_FUNCTION_STATE=$'build_leaderboard_rank_manifest_chunk_sha256_v1|0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322\nbuild_leaderboard_rank_manifest_chunks_sha256_v1|a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd\nbuild_leaderboard_rank_manifest_field_commitment_v1|72c4e558313daec92785722c35788e6490a4d9a2144261d0afe9d96666ea04f6\nencode_leaderboard_rank_manifest_fields_v1|504e8b8fc47f023bb9e821b7b6212f4df773cb94e63cfd5613fb2fff01964b16\nguard_leaderboard_rank_manifest_attestation_chunk_insert_v1|21cbd784ed8016f1a3acbe96ff82885d5679dce10697ddb658cb660ef449caa9\nleaderboard_rank_manifest_attestation_chunk_is_valid_v1|eaead90785261fd8400748497005d34013d468b5a836a0dbce0be38eaf843d07\nvalidate_leaderboard_rank_manifest_attestation_complete_v1|a67d03810591c130b7b6e7dbd63becc9b4d08eb4580fd314a223032e1f187e6b'
if [[ "$ATTESTATION_FUNCTION_STATE" != "$EXPECTED_ATTESTATION_FUNCTION_STATE" ]]; then
  echo 'manifest attestation helper body catalog drifted' >&2
  printf '%s\n' "$ATTESTATION_FUNCTION_STATE" >&2
  exit 1
fi

if [[ "$BENCHMARK_64K" == '1' ]]; then
  psql_cmd -q \
    -v benchmark_scenario="$BENCHMARK_SCENARIO" \
    -f "$CAPACITY_BENCHMARK"
  printf 'PostgreSQL 17 atomic leaderboard-rank 64k/64-batch %s capacity gate passed.\n' \
    "$BENCHMARK_SCENARIO"
  exit 0
fi

# Build the exact typed payload from the same sealed manifest input/output
# arrays that the writer must attest. Batch zero owns exactly 1,000 alpha
# identities and batch one owns one beta identity. This is the smallest real
# fixed-chunk topology and is globally C-ordered across the chunk boundary.
psql_cmd -q <<'SQL'
CREATE TABLE arena.fixture_atomic_writer_case (
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  computed_at timestamptz NOT NULL,
  score_input_manifest_id uuid NOT NULL,
  score_input_manifest_digest text NOT NULL,
  batch_sha256_plan text[] NOT NULL,
  batch_0_rows arena.leaderboard_rank_batch_row_v1[] NOT NULL,
  batch_1_rows arena.leaderboard_rank_batch_row_v1[] NOT NULL,
  write_set_sha256 text NOT NULL
);

DO $fixture$
DECLARE
  v_seal jsonb;
  v_manifest jsonb;
  v_manifest_id uuid;
  v_manifest_digest text;
  v_cohort constant uuid :=
    '17500000-0000-4750-8750-000000000001'::uuid;
  v_computed_at timestamptz := pg_catalog.clock_timestamp();
  v_batch_0 arena.leaderboard_rank_batch_row_v1[];
  v_batch_1 arena.leaderboard_rank_batch_row_v1[];
  v_inputs jsonb;
  v_included jsonb;
  v_evidence_0 jsonb;
  v_evidence_1 jsonb;
  v_plan text[];
  v_write_set text;
  v_claim jsonb;
BEGIN
  SELECT
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', generated.source,
        'source_trader_id', generated.source_trader_id,
        'roi', 30,
        'pnl', 12000,
        'max_drawdown', 8,
        'win_rate', 66,
        'sharpe_ratio', 2.2,
        'profit_factor', 2.1,
        'trades_count', 140
      )
      ORDER BY generated.ordinal_position
    ),
    pg_catalog.jsonb_agg(
      generated.source || ':' || generated.source_trader_id
      ORDER BY generated.ordinal_position
    )
  INTO STRICT v_inputs, v_included
  FROM (
    SELECT
      ordinal_position,
      CASE WHEN ordinal_position <= 1000 THEN 'alpha' ELSE 'beta' END
        AS source,
      'trader-' || pg_catalog.lpad(ordinal_position::text, 6, '0')
        AS source_trader_id
    FROM pg_catalog.generate_series(1, 1001) AS rows(ordinal_position)
  ) AS generated;

  v_seal := arena.seal_leaderboard_score_input_manifest_v1(
    '90D',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('c', 64),
    pg_catalog.jsonb_build_object(
      'contract', 'fixture-source-evidence@1',
      'sourceCount', 2,
      'sources', pg_catalog.jsonb_build_array('alpha', 'beta')
    ),
    'leaderboard-enrichment-evidence@1',
    pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-enrichment-evidence@1',
      'rows', 1001
    ),
    'leaderboard-eligibility-evidence@1',
    pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-eligibility-evidence@1',
      'canonicalIdentityCollisionCount', 0,
      'included', v_included
    ),
    v_inputs,
    pg_catalog.clock_timestamp() + interval '1 hour'
  );

  v_manifest_id := (v_seal->>'manifestId')::uuid;
  v_manifest_digest := v_seal->>'manifestDigest';
  SELECT stored.manifest
  INTO STRICT v_manifest
  FROM arena.leaderboard_score_input_manifests AS stored
  WHERE stored.manifest_id = v_manifest_id;

  WITH manifest_input AS MATERIALIZED (
    SELECT input_row.value
    FROM pg_catalog.jsonb_array_elements(v_manifest->'inputs') AS input_row(value)
  ),
  manifest_output AS MATERIALIZED (
    SELECT output_row.value
    FROM pg_catalog.jsonb_array_elements(v_manifest->'outputs') AS output_row(value)
  ),
  joined AS MATERIALIZED (
    SELECT
      input_row.value AS input_value,
      output_row.value AS output_value,
      output_row.value->'factors' AS factors,
      pg_catalog.row_number() OVER (
        ORDER BY
          (output_row.value->>'totalScore')::numeric DESC,
          (input_row.value->>'source') COLLATE pg_catalog."C",
          (input_row.value->>'source_trader_id') COLLATE pg_catalog."C"
      )::integer AS public_rank
    FROM manifest_input AS input_row
    JOIN manifest_output AS output_row
      ON output_row.value->>'source' = input_row.value->>'source'
     AND output_row.value->>'sourceTraderId' =
           input_row.value->>'source_trader_id'
  ),
  typed AS MATERIALIZED (
    SELECT
      joined.input_value->>'source' AS source,
      ROW(
        joined.input_value->>'source',
        'futures'::text,
        joined.input_value->>'source_trader_id',
        joined.public_rank,
        (joined.output_value->>'totalScore')::numeric,
        (joined.input_value->>'roi')::numeric,
        (joined.input_value->>'pnl')::numeric,
        (joined.input_value->>'win_rate')::numeric,
        (joined.input_value->>'max_drawdown')::numeric,
        (1001 - joined.public_rank)::integer,
        (joined.input_value->>'trades_count')::integer,
        'fixture-' || (joined.input_value->>'source_trader_id'),
        CASE
          WHEN joined.input_value->>'source_trader_id' = 'trader-000001'
            THEN NULL::text
          ELSE 'https://example.invalid/' ||
            (joined.input_value->>'source_trader_id') || '.png'
        END,
        pg_catalog.round(
          100::numeric * (
            0.3::numeric * (joined.factors->>'pnl')::numeric
            + 0.2::numeric * (joined.factors->>'roi')::numeric
          ) / 0.5::numeric
        ),
        pg_catalog.round(
          100::numeric * (
            COALESCE((joined.factors->>'drawdown')::numeric, 0)
            + COALESCE((joined.factors->>'sharpe')::numeric, 0)
          ) / pg_catalog.num_nonnulls(
            joined.factors->'drawdown',
            joined.factors->'sharpe'
          )::numeric
        ),
        CASE
          WHEN pg_catalog.jsonb_typeof(
                 joined.factors->'consistency'
               ) = 'null' THEN NULL::numeric
          ELSE pg_catalog.round(
            100::numeric *
              (joined.factors->>'consistency')::numeric
          )
        END,
        'full'::text,
        'swing'::text,
        CASE
          WHEN joined.input_value->>'source_trader_id' = 'trader-000001'
            THEN NULL::numeric
          ELSE 12.5::numeric
        END,
        0.8::numeric,
        (joined.input_value->>'sharpe_ratio')::numeric,
        CASE
          WHEN joined.input_value->>'source_trader_id' = 'trader-000001'
            THEN NULL::numeric
          ELSE 2.5::numeric
        END,
        (joined.input_value->>'profit_factor')::numeric,
        1.2::numeric,
        'verified'::text,
        false,
        false,
        0,
        true,
        10,
        (joined.output_value->>'totalScore')::numeric,
        (joined.output_value->>'totalScore')::numeric,
        joined.factors
      )::arena.leaderboard_rank_batch_row_v1 AS rank_row
    FROM joined
  )
  SELECT
    pg_catalog.array_agg(
      typed.rank_row ORDER BY
        typed.source COLLATE pg_catalog."C",
        (typed.rank_row).source_trader_id COLLATE pg_catalog."C"
    ) FILTER (WHERE typed.source = 'alpha'),
    pg_catalog.array_agg(
      typed.rank_row ORDER BY
        typed.source COLLATE pg_catalog."C",
        (typed.rank_row).source_trader_id COLLATE pg_catalog."C"
    ) FILTER (WHERE typed.source = 'beta')
  INTO STRICT v_batch_0, v_batch_1
  FROM typed;

  IF pg_catalog.cardinality(v_batch_0) <> 1000
     OR pg_catalog.cardinality(v_batch_1) <> 1 THEN
    RAISE EXCEPTION 'atomic writer fixture did not build the expected slices';
  END IF;

  v_evidence_0 := arena.build_leaderboard_rank_typed_batch_evidence_v1(
    '90D', v_cohort, v_computed_at, v_batch_0
  );
  v_evidence_1 := arena.build_leaderboard_rank_typed_batch_evidence_v1(
    '90D', v_cohort, v_computed_at, v_batch_1
  );
  v_plan := ARRAY[
    v_evidence_0->>'batch_sha256',
    v_evidence_1->>'batch_sha256'
  ]::text[];
  v_write_set :=
    arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      '90D',
      v_cohort,
      v_manifest_digest,
      v_computed_at,
      1001,
      v_plan
    );

  v_claim := public.claim_leaderboard_rank_generation(
    '90D',
    v_cohort,
    v_write_set,
    1001,
    2,
    v_computed_at,
    300
  );
  IF (v_claim->>'generation_seq')::bigint <> 1
     OR v_claim->>'score_cohort_id' IS DISTINCT FROM v_cohort::text THEN
    RAISE EXCEPTION 'atomic writer fixture claim drifted: %', v_claim;
  END IF;

  INSERT INTO arena.fixture_atomic_writer_case (
    season_id,
    generation_seq,
    score_cohort_id,
    computed_at,
    score_input_manifest_id,
    score_input_manifest_digest,
    batch_sha256_plan,
    batch_0_rows,
    batch_1_rows,
    write_set_sha256
  ) VALUES (
    '90D',
    1,
    v_cohort,
    v_computed_at,
    v_manifest_id,
    v_manifest_digest,
    v_plan,
    v_batch_0,
    v_batch_1,
    v_write_set
  );
END
$fixture$;
SQL

expect_failure \
  'service role executed the owner-only atomic writer' \
  'permission denied for function write_leaderboard_rank_generation_batch_v1' \
  "SET ROLE service_role; SELECT arena.write_leaderboard_rank_generation_batch_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL::arena.leaderboard_rank_batch_row_v1[]);"

# Seed one pre-generation legacy tuple. Its INSERT establishes alpha fence 1;
# batch zero must then update this identity and insert 999 peers in one UPSERT.
# PostgreSQL fires both transition-table mutation triggers, so the exact mixed
# source window is 1 -> 3. Nullable values and caller-like authority below are
# intentionally stale and must be overwritten, including explicit NULLs.
psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  season_id,
  source,
  source_type,
  source_trader_id,
  rank,
  arena_score,
  roi,
  pnl,
  win_rate,
  max_drawdown,
  followers,
  trades_count,
  handle,
  avatar_url,
  computed_at,
  profitability_score,
  risk_control_score,
  execution_score,
  score_completeness,
  trading_style,
  avg_holding_hours,
  style_confidence,
  sharpe_ratio,
  sortino_ratio,
  profit_factor,
  calmar_ratio,
  trader_type,
  is_outlier,
  metrics_estimated,
  rank_change,
  is_new,
  copiers,
  arena_score_v4,
  arena_score_v3,
  score_factors,
  rank_publication_id
) VALUES (
  '90D',
  'alpha',
  'legacy',
  'trader-000001',
  999,
  1,
  -99,
  -123,
  1,
  99,
  -1,
  1,
  'stale-handle',
  'https://example.invalid/stale.png',
  '2000-01-01 00:00:00+00'::timestamptz,
  1,
  1,
  1,
  'partial',
  'stale-style',
  999,
  0.01,
  0.01,
  999,
  0.01,
  0.01,
  'stale',
  true,
  true,
  -99,
  false,
  -99,
  1,
  1,
  '{"stale":true}'::jsonb,
  '17500000-0000-4750-8750-000000000099'::uuid
);

DO $seed_assertion$
BEGIN
  IF (
    SELECT fence.mutation_seq
    FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
    WHERE fence.season_id = '90D'
      AND fence.source = 'alpha'
  ) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'legacy seed did not establish alpha fence 1';
  END IF;
END
$seed_assertion$;
SQL

# Attestation tuples created below must carry the top-level writer XID. A
# SAVEPOINT/subtransaction has a different tuple xmin and therefore must roll
# every attempted rank, fence, binding, receipt, header, and chunk write back.
SUBXID_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'batch zero created attestation authority under a savepoint subxid' \
  'current-transaction|current transaction|subtransaction|subxid|attestation' \
  "BEGIN;
   SAVEPOINT nested_batch_zero;
   SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     0,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     case_row.batch_0_rows
   )
   FROM arena.fixture_atomic_writer_case AS case_row;
   RELEASE SAVEPOINT nested_batch_zero;
   COMMIT;"
SUBXID_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$SUBXID_STATE_AFTER" != "$SUBXID_STATE_BEFORE" ]]; then
  echo 'savepoint batch zero left partial rank or attestation authority' >&2
  exit 1
fi

# The writer restores its two exact batch-zero constraints to DEFERRED even if
# the caller made every deferrable constraint immediate before entry.
FIRST_RESULT="$(psql_cmd -Atq <<'SQL'
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT arena.write_leaderboard_rank_generation_batch_v1(
  case_row.season_id,
  case_row.generation_seq,
  case_row.score_cohort_id,
  0,
  case_row.score_input_manifest_id,
  case_row.score_input_manifest_digest,
  case_row.batch_sha256_plan,
  case_row.batch_0_rows
)::text
FROM arena.fixture_atomic_writer_case AS case_row;
COMMIT;
SQL
)"
if [[ "$FIRST_RESULT" != *'"batch_index": 0'* \
   || "$FIRST_RESULT" != *'"row_count": 1000'* ]]; then
  echo "first atomic batch returned an unexpected receipt: $FIRST_RESULT" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $batch_zero_attestation$
DECLARE
  v_case arena.fixture_atomic_writer_case%ROWTYPE;
  v_authority_xid text;
  v_state text;
  v_chunks_valid boolean;
BEGIN
  SELECT fixture.* INTO STRICT v_case
  FROM arena.fixture_atomic_writer_case AS fixture;

  SELECT receipt.xmin::text
  INTO STRICT v_authority_xid
  FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
  WHERE receipt.season_id = v_case.season_id
    AND receipt.generation_seq = v_case.generation_seq
    AND receipt.batch_index = 0;

  SELECT pg_catalog.concat_ws(
    '|',
    (SELECT binding.xmin::text
     FROM ONLY arena.leaderboard_rank_generation_manifest_bindings AS binding
     WHERE binding.season_id = v_case.season_id
       AND binding.generation_seq = v_case.generation_seq),
    (SELECT header.xmin::text
     FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
     WHERE header.season_id = v_case.season_id
       AND header.generation_seq = v_case.generation_seq),
    (SELECT pg_catalog.count(DISTINCT chunk.xmin::text)
     FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = v_case.season_id
       AND chunk.generation_seq = v_case.generation_seq),
    (SELECT pg_catalog.min(chunk.xmin::text)
     FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = v_case.season_id
       AND chunk.generation_seq = v_case.generation_seq),
    (SELECT header.positive_count
     FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
     WHERE header.season_id = v_case.season_id
       AND header.generation_seq = v_case.generation_seq),
    (SELECT header.chunk_count
     FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
     WHERE header.season_id = v_case.season_id
       AND header.generation_seq = v_case.generation_seq),
    (SELECT pg_catalog.count(*)
     FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = v_case.season_id
       AND chunk.generation_seq = v_case.generation_seq),
    (SELECT pg_catalog.sum(chunk.row_count)
     FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = v_case.season_id
       AND chunk.generation_seq = v_case.generation_seq),
    (SELECT pg_catalog.string_agg(
       chunk.chunk_index::text || ':' ||
       chunk.first_position::text || ':' || chunk.row_count::text,
       ',' ORDER BY chunk.chunk_index
     )
     FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = v_case.season_id
       AND chunk.generation_seq = v_case.generation_seq)
  ) INTO STRICT v_state;
  IF v_state IS DISTINCT FROM pg_catalog.concat_ws(
       '|',
       v_authority_xid,
       v_authority_xid,
       1,
       v_authority_xid,
       1001,
       2,
       2,
       1001,
       '0:1:1000,1:1001:1'
     ) THEN
    RAISE EXCEPTION 'batch-zero attestation XID/topology drifted: %', v_state;
  END IF;

  SELECT pg_catalog.bool_and(
    arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
      chunk.season_id,
      chunk.generation_seq,
      chunk.score_cohort_id,
      chunk.score_input_manifest_id,
      chunk.score_input_manifest_digest,
      chunk.chunk_index,
      chunk.first_position,
      chunk.row_count,
      chunk.identities,
      chunk.field_commitments,
      chunk.chunk_sha256
    )
  )
  INTO STRICT v_chunks_valid
  FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
  WHERE chunk.season_id = v_case.season_id
    AND chunk.generation_seq = v_case.generation_seq;
  IF v_chunks_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'batch-zero attestation chunk hash drifted';
  END IF;

  IF EXISTS (
    WITH batches(batch_index, rows) AS (
      VALUES (0, v_case.batch_0_rows), (1, v_case.batch_1_rows)
    ), typed_rows AS MATERIALIZED (
      SELECT
        batches.batch_index,
        position.ordinality,
        batches.rows[position.ordinality] AS rank_row
      FROM batches
      CROSS JOIN LATERAL pg_catalog.generate_subscripts(batches.rows, 1)
        AS position(ordinality)
    ), attested_rows AS MATERIALIZED (
      SELECT
        chunk.chunk_index AS batch_index,
        identity.ordinality,
        identity.value AS identity,
        commitment.value AS field_commitment
      FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(chunk.identities)
        WITH ORDINALITY AS identity(value, ordinality)
      JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        chunk.field_commitments
      ) WITH ORDINALITY AS commitment(value, ordinality)
        USING (ordinality)
      WHERE chunk.season_id = v_case.season_id
        AND chunk.generation_seq = v_case.generation_seq
    )
    SELECT 1
    FROM typed_rows
    FULL JOIN attested_rows
      ON attested_rows.batch_index = typed_rows.batch_index
     AND attested_rows.ordinality = typed_rows.ordinality
    WHERE typed_rows.rank_row IS NULL
       OR attested_rows.identity IS NULL
       OR attested_rows.identity->>0 IS DISTINCT FROM
            (typed_rows.rank_row).source
       OR attested_rows.identity->>1 IS DISTINCT FROM
            (typed_rows.rank_row).source_trader_id
       OR attested_rows.field_commitment IS DISTINCT FROM
            arena.build_leaderboard_rank_typed_field_commitment_v1(
              (typed_rows.rank_row).source,
              (typed_rows.rank_row).source_trader_id,
              (typed_rows.rank_row).roi,
              (typed_rows.rank_row).pnl,
              (typed_rows.rank_row).win_rate,
              (typed_rows.rank_row).max_drawdown,
              (typed_rows.rank_row).sharpe_ratio,
              (typed_rows.rank_row).profit_factor,
              (typed_rows.rank_row).trades_count,
              (typed_rows.rank_row).arena_score,
              (typed_rows.rank_row).score_factors,
              (typed_rows.rank_row).profitability_score,
              (typed_rows.rank_row).risk_control_score,
              (typed_rows.rank_row).execution_score
            )
  ) THEN
    RAISE EXCEPTION 'batch-zero attestation fields drifted from typed chunks';
  END IF;
END
$batch_zero_attestation$;
SQL

AFTER_BATCH_ZERO="$(psql_cmd -Atqc "
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.count(*) FROM public.leaderboard_ranks),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_batch_receipts),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_source_fence_receipts),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_manifest_bindings),
  (SELECT mutation_seq FROM arena.leaderboard_rank_mutation_fences WHERE season_id='90D' AND source='alpha'),
  (SELECT mutation_seq_before::text || ':' || mutation_seq_after::text FROM arena.leaderboard_rank_generation_source_fence_receipts WHERE season_id='90D' AND generation_seq=1 AND batch_index=0 AND source='alpha'),
  (SELECT phase FROM arena.leaderboard_rank_generation_heads WHERE season_id='90D'),
  (SELECT CASE WHEN avatar_url IS NULL AND avg_holding_hours IS NULL AND sortino_ratio IS NULL THEN 'nullable-cleared' ELSE 'nullable-stale' END FROM public.leaderboard_ranks WHERE season_id='90D' AND source='alpha' AND source_trader_id='trader-000001'),
  (SELECT CASE WHEN rank_row.computed_at = case_row.computed_at AND rank_row.rank_publication_id = case_row.score_cohort_id THEN 'authority-injected' ELSE 'authority-stale' END FROM public.leaderboard_ranks AS rank_row CROSS JOIN arena.fixture_atomic_writer_case AS case_row WHERE rank_row.season_id='90D' AND rank_row.source='alpha' AND rank_row.source_trader_id='trader-000001'),
  (SELECT updated_at::text FROM arena.leaderboard_rank_generation_heads WHERE season_id='90D')
);")"
if [[ "$AFTER_BATCH_ZERO" != 1000\|1\|1\|1\|3\|1:3\|writing\|nullable-cleared\|authority-injected\|* ]]; then
  echo "mixed insert-update batch recorded the wrong per-source fence delta: $AFTER_BATCH_ZERO" >&2
  if [[ "$AFTER_BATCH_ZERO" == *'nullable-stale'* ]]; then
    echo 'atomic upsert retained stale nullable rank fields' >&2
  fi
  if [[ "$AFTER_BATCH_ZERO" == *'authority-stale'* ]]; then
    echo 'atomic upsert trusted caller-owned generation authority' >&2
  fi
  exit 1
fi

# Batch zero has frozen the complete manifest into immutable chunks. Prove the
# next batch cannot depend on the raw scorer manifest by pruning it now, before
# every later-batch rejection and the eventual successful write.
psql_cmd -q <<'SQL'
DELETE FROM ONLY arena.leaderboard_score_input_manifests AS manifest
USING arena.fixture_atomic_writer_case AS case_row
WHERE manifest.manifest_id = case_row.score_input_manifest_id;
SQL

if [[ "$(psql_cmd -Atqc 'SELECT pg_catalog.count(*) FROM ONLY arena.leaderboard_score_input_manifests;')" != '0' ]]; then
  echo 'raw manifest was not pruned immediately after batch-zero attestation' >&2
  exit 1
fi

# A mutation to a source already covered by batch zero invalidates its durable
# fence before batch one can append. Put the mutation and writer call in one
# transaction so rejection must restore the exact prior state.
PRIOR_SOURCE_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'later batch ignored a mutation to a prior-batch source' \
  'prior.*source.*fence|source.*fence.*continue|mutation' \
  "BEGIN;
   UPDATE public.leaderboard_ranks
   SET handle='mutated-between-attested-batches'
   WHERE season_id='90D'
     AND source='alpha'
     AND source_trader_id='trader-000001';
   SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     1,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     case_row.batch_1_rows
   )
   FROM arena.fixture_atomic_writer_case AS case_row;
   COMMIT;"
PRIOR_SOURCE_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$PRIOR_SOURCE_STATE_AFTER" != "$PRIOR_SOURCE_STATE_BEFORE" ]]; then
  echo 'prior-source mutation rejection left partial durable state' >&2
  exit 1
fi

# Caller row order is not an alternative encoding. Even though the typed batch
# digest itself sorts identities, the attested writer accepts only the exact
# canonical chunk sequence supplied by batch zero.
NONCANONICAL_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'writer accepted a noncanonical row array order' \
  'canonical|order|attested.*chunk|chunk.*identity|manifest attestation replay' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     0,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     (SELECT pg_catalog.array_agg(
        input ORDER BY
          input.source COLLATE pg_catalog.\"C\" DESC,
          input.source_trader_id COLLATE pg_catalog.\"C\" DESC
      )
      FROM pg_catalog.unnest(case_row.batch_0_rows) AS input)
   )
   FROM arena.fixture_atomic_writer_case AS case_row;"
NONCANONICAL_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$NONCANONICAL_STATE_AFTER" != "$NONCANONICAL_STATE_BEFORE" ]]; then
  echo 'noncanonical batch rejection changed durable state' >&2
  exit 1
fi

# Batch index selects one and only one fixed chunk. A full batch-zero payload
# cannot be relabelled as the one-row second chunk.
WRONG_CHUNK_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'later writer accepted rows from the wrong attestation chunk' \
  'immutable generation plan|fixed chunk|attested.*chunk|chunk.*row' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     1,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     case_row.batch_0_rows
   )
   FROM arena.fixture_atomic_writer_case AS case_row;"
WRONG_CHUNK_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$WRONG_CHUNK_STATE_AFTER" != "$WRONG_CHUNK_STATE_BEFORE" ]]; then
  echo 'wrong-chunk rejection changed durable state' >&2
  exit 1
fi

DUPLICATE_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'later writer accepted a duplicate identity inside one chunk' \
  'duplicate identity|immutable generation plan|attested.*chunk' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     1,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     pg_catalog.array_append(case_row.batch_1_rows, case_row.batch_1_rows[1])
   )
   FROM arena.fixture_atomic_writer_case AS case_row;"
DUPLICATE_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$DUPLICATE_STATE_AFTER" != "$DUPLICATE_STATE_BEFORE" ]]; then
  echo 'duplicate-identity rejection changed durable state' >&2
  exit 1
fi

# Make the immutable chunk/header hashes internally self-consistent around one
# forged field commitment. The exact batch remains unchanged, so only the
# typed-to-attested commitment comparison can authorize or reject this call.
COMMITMENT_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'later writer accepted a forged attested field commitment' \
  'field.*commitment|commitment.*attest|attested.*field|fields.*manifest attestation' \
  "BEGIN;
   ALTER TABLE arena.leaderboard_rank_manifest_attestation_chunks
     DISABLE TRIGGER leaderboard_rank_manifest_attestation_chunks_immutable;
   ALTER TABLE arena.leaderboard_rank_manifest_attestations
     DISABLE TRIGGER leaderboard_rank_manifest_attestations_immutable;
   WITH forged AS MATERIALIZED (
     SELECT
       chunk.season_id,
       chunk.generation_seq,
       chunk.chunk_index,
       pg_catalog.jsonb_set(
         chunk.field_commitments,
         ARRAY['0'],
         pg_catalog.to_jsonb(pg_catalog.repeat('f', 64)),
         false
       ) AS field_commitments
     FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id='90D'
       AND chunk.generation_seq=1
       AND chunk.chunk_index=1
   )
   UPDATE ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
   SET
     field_commitments = forged.field_commitments,
     chunk_sha256 =
       arena.build_leaderboard_rank_manifest_chunk_sha256_v1(
         chunk.season_id,
         chunk.generation_seq,
         chunk.score_cohort_id,
         chunk.score_input_manifest_id,
         chunk.score_input_manifest_digest,
         chunk.chunk_index,
         chunk.first_position,
         chunk.row_count,
         chunk.identities,
         forged.field_commitments
       )
   FROM forged
   WHERE chunk.season_id=forged.season_id
     AND chunk.generation_seq=forged.generation_seq
     AND chunk.chunk_index=forged.chunk_index;
   UPDATE ONLY arena.leaderboard_rank_manifest_attestations AS header
   SET chunks_sha256 = arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
     header.season_id,
     header.generation_seq,
     header.score_cohort_id,
     header.score_input_manifest_id,
     header.score_input_manifest_digest,
     header.positive_count,
     header.chunk_count,
     (SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          chunk.chunk_index,
          chunk.first_position,
          chunk.row_count,
          chunk.chunk_sha256
        ) ORDER BY chunk.chunk_index)
      FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
      WHERE chunk.season_id=header.season_id
        AND chunk.generation_seq=header.generation_seq)
   )
   WHERE header.season_id='90D' AND header.generation_seq=1;
   ALTER TABLE arena.leaderboard_rank_manifest_attestation_chunks
     ENABLE TRIGGER leaderboard_rank_manifest_attestation_chunks_immutable;
   ALTER TABLE arena.leaderboard_rank_manifest_attestations
     ENABLE TRIGGER leaderboard_rank_manifest_attestations_immutable;
   SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     1,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     case_row.batch_1_rows
   )
   FROM arena.fixture_atomic_writer_case AS case_row;
   COMMIT;"
COMMITMENT_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$COMMITMENT_STATE_AFTER" != "$COMMITMENT_STATE_BEFORE" ]]; then
  echo 'field-commitment rejection left forged or partial durable state' >&2
  exit 1
fi

# Cross one internally consistent claim/head/attestation validity boundary
# inside the same transaction. The failed writer must roll the temporary owner
# mutations and every attempted batch effect back together.
ATTESTATION_EXPIRY_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'later writer accepted an expired manifest attestation' \
  'attestation.*expired|expired.*attestation|valid.*until|validity|generation lease expired' \
  "BEGIN;
   ALTER TABLE arena.leaderboard_rank_generation_claims
     DISABLE TRIGGER leaderboard_rank_generation_claim_immutable;
   ALTER TABLE arena.leaderboard_rank_manifest_attestations
     DISABLE TRIGGER leaderboard_rank_manifest_attestations_immutable;
   WITH deadline AS MATERIALIZED (
     SELECT pg_catalog.clock_timestamp()+interval '300 milliseconds' AS value
   )
   UPDATE ONLY arena.leaderboard_rank_generation_claims AS claim
   SET
     lease_seconds=15,
     claimed_at=deadline.value-interval '15 seconds',
     lease_expires_at=deadline.value
   FROM deadline
   WHERE claim.season_id='90D' AND claim.generation_seq=1;
   UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
   SET lease_expires_at=claim.lease_expires_at
   FROM ONLY arena.leaderboard_rank_generation_claims AS claim
   WHERE head.season_id=claim.season_id
     AND head.generation_seq=claim.generation_seq
     AND head.score_cohort_id=claim.score_cohort_id
     AND head.season_id='90D' AND head.generation_seq=1;
   UPDATE ONLY arena.leaderboard_rank_manifest_attestations AS header
   SET manifest_valid_until=claim.lease_expires_at
   FROM ONLY arena.leaderboard_rank_generation_claims AS claim
   WHERE header.season_id=claim.season_id
     AND header.generation_seq=claim.generation_seq
     AND header.score_cohort_id=claim.score_cohort_id
     AND header.season_id='90D' AND header.generation_seq=1;
   ALTER TABLE arena.leaderboard_rank_generation_claims
     ENABLE TRIGGER leaderboard_rank_generation_claim_immutable;
   ALTER TABLE arena.leaderboard_rank_manifest_attestations
     ENABLE TRIGGER leaderboard_rank_manifest_attestations_immutable;
   SELECT pg_catalog.pg_sleep(0.4);
   SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     1,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     case_row.batch_1_rows
   )
   FROM arena.fixture_atomic_writer_case AS case_row;
   COMMIT;"
ATTESTATION_EXPIRY_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$ATTESTATION_EXPIRY_STATE_AFTER" != "$ATTESTATION_EXPIRY_STATE_BEFORE" ]]; then
  echo 'expired-attestation rejection changed durable state' >&2
  exit 1
fi

# Corrupt the physical tuple only after the writer has accepted the typed row.
# The persisted-codec equality check must reject it; PostgreSQL must then undo
# the rank UPSERT, mutation-fence bump, receipt inserts, and head update as one
# transaction. This is intentionally a parent row trigger, so it follows the
# same partition routing path as production writes.
psql_cmd -q <<'SQL'
CREATE FUNCTION public.fixture_corrupt_atomic_rank()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.source = 'beta' THEN
    NEW.handle := 'corrupted-after-validation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER fixture_corrupt_atomic_rank
BEFORE INSERT OR UPDATE ON public.leaderboard_ranks
FOR EACH ROW EXECUTE FUNCTION public.fixture_corrupt_atomic_rank();
SQL

PERSISTED_FAILURE_STATE_BEFORE="$(capture_atomic_state false)"

expect_failure \
  'post-write persisted evidence mismatch' \
  'persisted.*evidence|typed.*persisted|persisted.*typed' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(case_row.season_id,case_row.generation_seq,case_row.score_cohort_id,1,case_row.score_input_manifest_id,case_row.score_input_manifest_digest,case_row.batch_sha256_plan,case_row.batch_1_rows) FROM arena.fixture_atomic_writer_case AS case_row;"

PERSISTED_FAILURE_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$PERSISTED_FAILURE_STATE_AFTER" != "$PERSISTED_FAILURE_STATE_BEFORE" ]]; then
  echo 'persisted mismatch changed rank, head, fence, or receipt state' >&2
  printf 'before: %s\nafter:  %s\n' \
    "$PERSISTED_FAILURE_STATE_BEFORE" "$PERSISTED_FAILURE_STATE_AFTER" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DROP TRIGGER fixture_corrupt_atomic_rank ON public.leaderboard_ranks;
DROP FUNCTION public.fixture_corrupt_atomic_rank();
SQL

# Prove the final post-DML clock check, not merely the first authorization
# check. Keep the claim's minimum legal 15-second lease while moving claimed_at
# into the past so only a short live tail remains. The AFTER ROW trigger records
# its invocation in a nontransactional test sequence, then sleeps just beyond
# the shared claim/head expiry. A failure before physical DML cannot advance
# that sequence and therefore cannot satisfy this proof.
psql_cmd -q <<'SQL'
CREATE SEQUENCE arena.fixture_atomic_rank_sleep_calls;

CREATE FUNCTION public.fixture_sleep_atomic_rank_past_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_lease_expires_at timestamptz;
BEGIN
  IF NEW.season_id = '90D'
     AND NEW.source = 'beta'
     AND NEW.source_trader_id = 'trader-001001' THEN
    PERFORM pg_catalog.nextval(
      'arena.fixture_atomic_rank_sleep_calls'::pg_catalog.regclass
    );
    SELECT head.lease_expires_at
    INTO STRICT v_lease_expires_at
    FROM ONLY arena.leaderboard_rank_generation_heads AS head
    WHERE head.season_id = NEW.season_id;
    PERFORM pg_catalog.pg_sleep_until(
      v_lease_expires_at + interval '100 milliseconds'
    );
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER fixture_sleep_atomic_rank_past_lease
AFTER INSERT OR UPDATE ON public.leaderboard_ranks
FOR EACH ROW EXECUTE FUNCTION public.fixture_sleep_atomic_rank_past_lease();

ALTER TABLE arena.leaderboard_rank_generation_claims
  DISABLE TRIGGER leaderboard_rank_generation_claim_immutable;
DO $short_lease$
DECLARE
  v_lease_expires_at timestamptz :=
    pg_catalog.clock_timestamp() + interval '3 seconds';
BEGIN
  UPDATE ONLY arena.leaderboard_rank_generation_claims AS claim
  SET claimed_at = v_lease_expires_at - interval '15 seconds',
      lease_seconds = 15,
      lease_expires_at = v_lease_expires_at
  WHERE claim.season_id = '90D'
    AND claim.generation_seq = 1;

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET lease_expires_at = v_lease_expires_at
  WHERE head.season_id = '90D'
    AND head.generation_seq = 1;
END
$short_lease$;
ALTER TABLE arena.leaderboard_rank_generation_claims
  ENABLE TRIGGER leaderboard_rank_generation_claim_immutable;

DO $trigger_assertion$
BEGIN
  IF (
    SELECT trigger_row.tgenabled
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
          'arena.leaderboard_rank_generation_claims'::regclass
      AND trigger_row.tgname =
          'leaderboard_rank_generation_claim_immutable'
      AND NOT trigger_row.tgisinternal
  ) IS DISTINCT FROM 'O'::"char" THEN
    RAISE EXCEPTION 'claim immutable trigger was not restored';
  END IF;
END
$trigger_assertion$;
SQL

EXPIRED_BATCH_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'post-lock clock did not reject an expired writer lease' \
  'generation lease expired while atomic batch write was waiting|generation lease expired before atomic batch commit' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(case_row.season_id,case_row.generation_seq,case_row.score_cohort_id,1,case_row.score_input_manifest_id,case_row.score_input_manifest_digest,case_row.batch_sha256_plan,case_row.batch_1_rows) FROM arena.fixture_atomic_writer_case AS case_row;"
EXPIRED_BATCH_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$EXPIRED_BATCH_STATE_AFTER" != "$EXPIRED_BATCH_STATE_BEFORE" ]]; then
  echo 'expired-after-lock batch changed rank, head, fence, or receipt state' >&2
  printf 'before: %s\nafter:  %s\n' \
    "$EXPIRED_BATCH_STATE_BEFORE" "$EXPIRED_BATCH_STATE_AFTER" >&2
  exit 1
fi

SLEEP_TRIGGER_PROOF="$(psql_cmd -Atqc "
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.count(*) FROM public.leaderboard_ranks WHERE season_id='90D' AND source='beta' AND source_trader_id='trader-001001'),
  (SELECT last_value FROM arena.fixture_atomic_rank_sleep_calls),
  (SELECT is_called FROM arena.fixture_atomic_rank_sleep_calls)
);")"
if [[ "$SLEEP_TRIGGER_PROOF" != '0|1|t' ]]; then
  echo "expired writer did not reach physical rank DML before rollback: $SLEEP_TRIGGER_PROOF" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DROP TRIGGER fixture_sleep_atomic_rank_past_lease
  ON public.leaderboard_ranks;
DROP FUNCTION public.fixture_sleep_atomic_rank_past_lease();
DROP SEQUENCE arena.fixture_atomic_rank_sleep_calls;

ALTER TABLE arena.leaderboard_rank_generation_claims
  DISABLE TRIGGER leaderboard_rank_generation_claim_immutable;
DO $restore_lease$
DECLARE
  v_claimed_at timestamptz := pg_catalog.clock_timestamp();
  v_lease_expires_at timestamptz := v_claimed_at + interval '300 seconds';
BEGIN
  UPDATE ONLY arena.leaderboard_rank_generation_claims AS claim
  SET claimed_at = v_claimed_at,
      lease_seconds = 300,
      lease_expires_at = v_lease_expires_at
  WHERE claim.season_id = '90D'
    AND claim.generation_seq = 1;

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET lease_expires_at = v_lease_expires_at
  WHERE head.season_id = '90D'
    AND head.generation_seq = 1;
END
$restore_lease$;
ALTER TABLE arena.leaderboard_rank_generation_claims
  ENABLE TRIGGER leaderboard_rank_generation_claim_immutable;
SQL

SECOND_RESULT="$(psql_cmd -Atq <<'SQL'
SELECT arena.write_leaderboard_rank_generation_batch_v1(
  case_row.season_id,
  case_row.generation_seq,
  case_row.score_cohort_id,
  1,
  case_row.score_input_manifest_id,
  case_row.score_input_manifest_digest,
  case_row.batch_sha256_plan,
  case_row.batch_1_rows
)::text
FROM arena.fixture_atomic_writer_case AS case_row;
SQL
)"
if [[ "$SECOND_RESULT" != *'"batch_index": 1'* \
   || "$SECOND_RESULT" != *'"row_count": 1'* ]]; then
  echo "second atomic batch returned an unexpected receipt: $SECOND_RESULT" >&2
  exit 1
fi

COMPLETE_STATE="$(psql_cmd -Atqc "
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.count(*) FROM public.leaderboard_ranks AS rank_row JOIN arena.fixture_atomic_writer_case AS case_row ON rank_row.season_id=case_row.season_id AND rank_row.rank_publication_id=case_row.score_cohort_id),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_batch_receipts),
  (SELECT pg_catalog.sum(row_count) FROM arena.leaderboard_rank_generation_batch_receipts),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_source_fence_receipts),
  (SELECT pg_catalog.string_agg(source || ':' || mutation_seq_before || ':' || mutation_seq_after, ',' ORDER BY source COLLATE pg_catalog.\"C\") FROM arena.leaderboard_rank_generation_source_fence_receipts),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_manifest_bindings),
  (SELECT phase FROM arena.leaderboard_rank_generation_heads WHERE season_id='90D')
);")"
if [[ "$COMPLETE_STATE" != '1001|2|1001|2|alpha:1:3,beta:0:1|1|writing' ]]; then
  echo "successful atomic batch did not commit ranks and receipts together: $COMPLETE_STATE" >&2
  exit 1
fi

PERSISTED_EQUALITY="$(psql_cmd -Atqc "
WITH batches(batch_rows) AS (
  SELECT case_row.batch_0_rows
  FROM arena.fixture_atomic_writer_case AS case_row
  UNION ALL
  SELECT case_row.batch_1_rows
  FROM arena.fixture_atomic_writer_case AS case_row
), batch_evidence AS (
  SELECT
    arena.build_leaderboard_rank_typed_batch_evidence_v1(
      case_row.season_id,
      case_row.score_cohort_id,
      case_row.computed_at,
      batches.batch_rows
    ) AS typed_evidence,
    arena.build_leaderboard_rank_batch_evidence_v1(
      case_row.season_id,
      case_row.score_cohort_id,
      identities.value
    ) AS persisted_evidence
  FROM batches
  CROSS JOIN arena.fixture_atomic_writer_case AS case_row
  CROSS JOIN LATERAL (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', typed_row.source,
        'source_trader_id', typed_row.source_trader_id
      )
      ORDER BY
        typed_row.source COLLATE pg_catalog.\"C\",
        typed_row.source_trader_id COLLATE pg_catalog.\"C\"
    ) AS value
    FROM pg_catalog.unnest(batches.batch_rows) AS typed_row
  ) AS identities
)
SELECT pg_catalog.bool_and(
  batch_evidence.typed_evidence = batch_evidence.persisted_evidence
)::text
FROM batch_evidence;")"
if [[ "$PERSISTED_EQUALITY" != 'true' ]]; then
  echo 'persisted evidence was not byte-identical to typed evidence' >&2
  exit 1
fi

# A receipt is the immutable response-loss authority. Exercise the same exact
# request against three progressively weaker live-state environments. Each
# stage compares the canonical full relational state plus the nontransactional
# surrogate sequence, so a replay cannot silently repair or rewrite anything.

# Stage one: the head is still writing, but its shared live lease has expired.
psql_cmd -q <<'SQL'
UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
SET lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second',
    updated_at = pg_catalog.clock_timestamp()
WHERE head.season_id = '90D'
  AND head.generation_seq = 1;
SQL

EXPIRED_REPLAY_STATE_BEFORE="$(capture_atomic_state)"
EXPIRED_REPLAY_RESULT="$(replay_batch_zero)"
if [[ "$EXPIRED_REPLAY_RESULT" != "$FIRST_RESULT" ]]; then
  echo 'expired generation exact replay was not frozen' >&2
  printf 'first:  %s\nreplay: %s\n' \
    "$FIRST_RESULT" "$EXPIRED_REPLAY_RESULT" >&2
  exit 1
fi
EXPIRED_REPLAY_STATE_AFTER="$(capture_atomic_state)"
if [[ "$EXPIRED_REPLAY_STATE_AFTER" != "$EXPIRED_REPLAY_STATE_BEFORE" ]]; then
  echo 'exact replay changed rank, head, fence, receipt, or sequence state during expired-head replay' >&2
  printf 'before: %s\nafter:  %s\n' \
    "$EXPIRED_REPLAY_STATE_BEFORE" "$EXPIRED_REPLAY_STATE_AFTER" >&2
  exit 1
fi

# Stage two: prune the scorer manifest entirely. The immutable binding and
# receipts remain; a replay must neither require nor reconstruct the manifest.
psql_cmd -q <<'SQL'
DELETE FROM ONLY arena.leaderboard_score_input_manifests AS manifest
USING arena.fixture_atomic_writer_case AS case_row
WHERE manifest.manifest_id = case_row.score_input_manifest_id;
SQL

PRUNED_REPLAY_STATE_BEFORE="$(capture_atomic_state)"
PRUNED_REPLAY_RESULT="$(replay_batch_zero)"
if [[ "$PRUNED_REPLAY_RESULT" != "$FIRST_RESULT" ]]; then
  echo 'exact replay depended on a pruned manifest' >&2
  printf 'first:  %s\nreplay: %s\n' \
    "$FIRST_RESULT" "$PRUNED_REPLAY_RESULT" >&2
  exit 1
fi
PRUNED_REPLAY_STATE_AFTER="$(capture_atomic_state)"
if [[ "$PRUNED_REPLAY_STATE_AFTER" != "$PRUNED_REPLAY_STATE_BEFORE" ]]; then
  echo 'exact replay changed rank, head, fence, receipt, or sequence state after manifest pruning' >&2
  printf 'before: %s\nafter:  %s\n' \
    "$PRUNED_REPLAY_STATE_BEFORE" "$PRUNED_REPLAY_STATE_AFTER" >&2
  exit 1
fi

# Stage three: make the head terminal and let a later legacy writer drift the
# persisted rank tuple and alpha fence beyond the immutable receipt window.
psql_cmd -q <<'SQL'
UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
SET phase = 'sealed',
    lease_expires_at = NULL,
    updated_at = pg_catalog.clock_timestamp()
WHERE head.season_id = '90D'
  AND head.generation_seq = 1;

UPDATE public.leaderboard_ranks AS rank_row
SET handle = 'legacy-after-seal'
WHERE rank_row.season_id = '90D'
  AND rank_row.source = 'alpha'
  AND rank_row.source_trader_id = 'trader-000001';
SQL

TERMINAL_REPLAY_STATE_BEFORE="$(capture_atomic_state)"
TERMINAL_REPLAY_RESULT="$(replay_batch_zero)"
if [[ "$TERMINAL_REPLAY_RESULT" != "$FIRST_RESULT" ]]; then
  echo 'terminal generation exact replay was not frozen' >&2
  printf 'first:  %s\nreplay: %s\n' \
    "$FIRST_RESULT" "$TERMINAL_REPLAY_RESULT" >&2
  exit 1
fi
TERMINAL_REPLAY_STATE_AFTER="$(capture_atomic_state)"
if [[ "$TERMINAL_REPLAY_STATE_AFTER" != "$TERMINAL_REPLAY_STATE_BEFORE" ]]; then
  echo 'exact replay changed rank, head, fence, receipt, or sequence state after terminal drift' >&2
  printf 'before: %s\nafter:  %s\n' \
    "$TERMINAL_REPLAY_STATE_BEFORE" "$TERMINAL_REPLAY_STATE_AFTER" >&2
  exit 1
fi

# The receipt path remains fail-closed. First change one caller-owned field so
# the typed batch digest no longer matches the immutable write-set plan.
ALTERED_REPLAY_STATE_BEFORE="$(capture_atomic_state)"
expect_failure \
  'replay accepted a different immutable batch payload' \
  'atomic rank batch does not match immutable generation plan' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(case_row.season_id,case_row.generation_seq,case_row.score_cohort_id,0,case_row.score_input_manifest_id,case_row.score_input_manifest_digest,case_row.batch_sha256_plan,(SELECT pg_catalog.array_agg(pg_catalog.jsonb_populate_record(NULL::arena.leaderboard_rank_batch_row_v1,pg_catalog.to_jsonb(input) || CASE WHEN input.source_trader_id='trader-000001' THEN pg_catalog.jsonb_build_object('handle','altered-replay') ELSE '{}'::jsonb END) ORDER BY input.source COLLATE pg_catalog.\"C\",input.source_trader_id COLLATE pg_catalog.\"C\") FROM pg_catalog.unnest(case_row.batch_0_rows) AS input)) FROM arena.fixture_atomic_writer_case AS case_row;"
ALTERED_REPLAY_STATE_AFTER="$(capture_atomic_state)"
if [[ "$ALTERED_REPLAY_STATE_AFTER" != "$ALTERED_REPLAY_STATE_BEFORE" ]]; then
  echo 'altered immutable replay payload changed durable state' >&2
  exit 1
fi

# Then remove the sole alpha source proof behind batch zero while leaving its
# parent receipt intact. The immutable trigger is restored before invoking the
# writer. Rejection must be zero-write, and the exact row is restored afterward
# so this adversarial proof leaves the authority topology byte-identical.
TOPOLOGY_FULL_STATE="$(capture_atomic_state)"
psql_cmd -q <<'SQL'
CREATE TABLE arena.fixture_atomic_source_receipt_backup AS
SELECT source_receipt.*
FROM ONLY arena.leaderboard_rank_generation_source_fence_receipts
  AS source_receipt
WHERE source_receipt.season_id = '90D'
  AND source_receipt.generation_seq = 1
  AND source_receipt.batch_index = 0
  AND source_receipt.source = 'alpha';

ALTER TABLE arena.leaderboard_rank_generation_source_fence_receipts
  DISABLE TRIGGER
    leaderboard_rank_generation_source_fence_receipts_immutable;
DELETE FROM ONLY arena.leaderboard_rank_generation_source_fence_receipts
WHERE season_id = '90D'
  AND generation_seq = 1
  AND batch_index = 0
  AND source = 'alpha';
ALTER TABLE arena.leaderboard_rank_generation_source_fence_receipts
  ENABLE TRIGGER
    leaderboard_rank_generation_source_fence_receipts_immutable;
SQL

TOPOLOGY_BROKEN_STATE_BEFORE="$(capture_atomic_state)"
expect_failure \
  'replay accepted incomplete source-receipt topology' \
  'generation batch receipt conflicts with immutable replay' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(case_row.season_id,case_row.generation_seq,case_row.score_cohort_id,0,case_row.score_input_manifest_id,case_row.score_input_manifest_digest,case_row.batch_sha256_plan,case_row.batch_0_rows) FROM arena.fixture_atomic_writer_case AS case_row;"
TOPOLOGY_BROKEN_STATE_AFTER="$(capture_atomic_state)"
if [[ "$TOPOLOGY_BROKEN_STATE_AFTER" != "$TOPOLOGY_BROKEN_STATE_BEFORE" ]]; then
  echo 'receipt conflict left a partially written rank batch' >&2
  exit 1
fi

psql_cmd -q <<'SQL'
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
)
SELECT
  backup.contract,
  backup.season_id,
  backup.generation_seq,
  backup.batch_index,
  backup.source,
  backup.source_row_count,
  backup.source_identity_sha256,
  backup.mutation_seq_before,
  backup.mutation_seq_after
FROM arena.fixture_atomic_source_receipt_backup AS backup;
DROP TABLE arena.fixture_atomic_source_receipt_backup;
SQL

TOPOLOGY_RESTORED_STATE="$(capture_atomic_state)"
if [[ "$TOPOLOGY_RESTORED_STATE" != "$TOPOLOGY_FULL_STATE" ]]; then
  echo 'temporary source-receipt topology was not fully restored' >&2
  exit 1
fi

# A pre-attestation deployment may already contain batch-zero receipts. Never
# infer or backfill manifest commitments from that old authority. Remove only
# the attestation graph at the end of the proof, then require exact replay to
# fail without changing any remaining rank/receipt/fence state.
psql_cmd -q <<'SQL'
ALTER TABLE arena.leaderboard_rank_manifest_attestation_chunks
  DISABLE TRIGGER leaderboard_rank_manifest_attestation_chunks_immutable;
ALTER TABLE arena.leaderboard_rank_manifest_attestations
  DISABLE TRIGGER leaderboard_rank_manifest_attestations_immutable;
DELETE FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks
WHERE season_id='90D' AND generation_seq=1;
DELETE FROM ONLY arena.leaderboard_rank_manifest_attestations
WHERE season_id='90D' AND generation_seq=1;
ALTER TABLE arena.leaderboard_rank_manifest_attestation_chunks
  ENABLE TRIGGER leaderboard_rank_manifest_attestation_chunks_immutable;
ALTER TABLE arena.leaderboard_rank_manifest_attestations
  ENABLE TRIGGER leaderboard_rank_manifest_attestations_immutable;

DO $legacy_receipt_shape$
BEGIN
  IF (SELECT pg_catalog.count(*)
      FROM ONLY arena.leaderboard_rank_generation_batch_receipts
      WHERE season_id='90D' AND generation_seq=1) <> 2
     OR EXISTS (
       SELECT 1 FROM ONLY arena.leaderboard_rank_manifest_attestations
       WHERE season_id='90D' AND generation_seq=1
     )
     OR EXISTS (
       SELECT 1 FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks
       WHERE season_id='90D' AND generation_seq=1
     ) THEN
    RAISE EXCEPTION 'legacy receipt without attestation fixture drifted';
  END IF;
END
$legacy_receipt_shape$;
SQL

UNATTESTED_REPLAY_STATE_BEFORE="$(capture_atomic_state false)"
expect_failure \
  'old batch-zero receipt replayed without an attestation' \
  'unattested|attestation|manifest.*commitment' \
  "SELECT arena.write_leaderboard_rank_generation_batch_v1(
     case_row.season_id,
     case_row.generation_seq,
     case_row.score_cohort_id,
     0,
     case_row.score_input_manifest_id,
     case_row.score_input_manifest_digest,
     case_row.batch_sha256_plan,
     case_row.batch_0_rows
   )
   FROM arena.fixture_atomic_writer_case AS case_row;"
UNATTESTED_REPLAY_STATE_AFTER="$(capture_atomic_state false)"
if [[ "$UNATTESTED_REPLAY_STATE_AFTER" != "$UNATTESTED_REPLAY_STATE_BEFORE" ]]; then
  echo 'unattested legacy replay changed durable state' >&2
  exit 1
fi

WRITER_BODY_SHA256="$(psql_cmd -Atqc "
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(function_row.prosrc, 'UTF8')
  ),
  'hex'
)
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
    ::pg_catalog.regprocedure;")"
if [[ ! "$WRITER_BODY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "atomic writer body SHA256 is invalid: $WRITER_BODY_SHA256" >&2
  exit 1
fi
printf 'writer-body|%s\n' "$WRITER_BODY_SHA256"

# Emit one reproducible catalog digest and one ACL digest for the complete
# twelve-function authority surface consumed by the writer. OIDs are resolved
# only for lookup; the preimages use stable formatted types, role/language
# names, body hashes, catalog flags, and canonically expanded privileges.
DEPENDENCY_DIGESTS="$(psql_cmd -Atq <<'SQL'
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
WITH expected(signature) AS (
  VALUES
    ('public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'),
    ('arena.validate_leaderboard_rank_generation_manifest_binding()'),
    ('arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'),
    ('arena.verify_leaderboard_score_input_manifest_v1(uuid)'),
    ('arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'),
    ('arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'),
    ('arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'),
    ('arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'),
    ('arena.bump_leaderboard_rank_insert_fences()'),
    ('arena.bump_leaderboard_rank_update_fences()'),
    ('arena.bump_leaderboard_rank_delete_fences()'),
    ('arena.reject_leaderboard_rank_publication_mutation()')
), resolved AS MATERIALIZED (
  SELECT expected.signature, function_row.*, language_row.lanname
  FROM expected
  JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
), catalog_preimage AS (
  SELECT pg_catalog.jsonb_build_array(
    'leaderboard-rank-atomic-writer-dependency-catalog@1',
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'signature', resolved.signature,
        'owner', pg_catalog.pg_get_userbyid(resolved.proowner),
        'language', resolved.lanname,
        'kind', resolved.prokind,
        'volatility', resolved.provolatile,
        'parallel', resolved.proparallel,
        'securityDefiner', resolved.prosecdef,
        'leakproof', resolved.proleakproof,
        'strict', resolved.proisstrict,
        'returnsSet', resolved.proretset,
        'returnType', pg_catalog.format_type(resolved.prorettype, NULL),
        'argumentTypes', pg_catalog.oidvectortypes(resolved.proargtypes),
        'argumentNames', pg_catalog.to_jsonb(resolved.proargnames),
        'argumentModes', pg_catalog.to_jsonb(resolved.proargmodes),
        'argumentDefaults', resolved.pronargdefaults,
        'config', pg_catalog.to_jsonb(resolved.proconfig),
        'cost', resolved.procost,
        'rows', resolved.prorows,
        'support', resolved.prosupport::integer,
        'sqlBodyIsNull', resolved.prosqlbody IS NULL,
        'bin', resolved.probin,
        'bodySha256', pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(resolved.prosrc, 'UTF8')
          ),
          'hex'
        )
      )
      ORDER BY resolved.signature COLLATE pg_catalog."C"
    )
  ) AS value,
  pg_catalog.count(*)::integer AS entry_count
  FROM resolved
), acl_preimage AS (
  SELECT pg_catalog.jsonb_build_array(
    'leaderboard-rank-atomic-writer-dependency-acl@1',
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'signature', resolved.signature,
        'grantor', pg_catalog.pg_get_userbyid(expanded.grantor),
        'grantee', CASE expanded.grantee
          WHEN 0 THEN 'PUBLIC'
          ELSE pg_catalog.pg_get_userbyid(expanded.grantee)
        END,
        'privilege', expanded.privilege_type,
        'grantable', expanded.is_grantable
      )
      ORDER BY
        resolved.signature COLLATE pg_catalog."C",
        expanded.grantee,
        expanded.grantor,
        expanded.privilege_type COLLATE pg_catalog."C",
        expanded.is_grantable
    )
  ) AS value,
  pg_catalog.count(*)::integer AS entry_count
  FROM resolved
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      resolved.proacl,
      pg_catalog.acldefault('f', resolved.proowner)
    )
  ) AS expanded
)
SELECT 'catalog|' || catalog_preimage.entry_count::text || '|' ||
  pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(catalog_preimage.value::text, 'UTF8')
  ),
  'hex'
)
FROM catalog_preimage
UNION ALL
SELECT 'acl|' || acl_preimage.entry_count::text || '|' ||
  pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(acl_preimage.value::text, 'UTF8')
  ),
  'hex'
)
FROM acl_preimage
ORDER BY 1;
COMMIT;
SQL
)"
EXPECTED_DEPENDENCY_DIGESTS=$'acl|13|e8d93b0faac5f16601a1b7a3e750fe46345ec2465e67297bb52fefdf005cdd74\ncatalog|12|cbd7e49f7890141ba10d9f8c90d382ebbfa62e007b073ec5f540a5ed4ef16d89'
if [[ "$DEPENDENCY_DIGESTS" != "$EXPECTED_DEPENDENCY_DIGESTS" ]]; then
  echo "atomic writer dependency catalog/ACL population drifted: $DEPENDENCY_DIGESTS" >&2
  exit 1
fi
printf '%s\n' "$DEPENDENCY_DIGESTS"

printf '%s\n' \
  'PostgreSQL 17 atomic leaderboard-rank batch writer proof passed.'
