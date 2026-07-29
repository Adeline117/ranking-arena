#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for the dormant, owner-only rank-manifest
# attestation substrate. It installs the real dependency chain, commits valid
# one- and two-chunk attestations, and proves that every malformed authority
# attempt rolls its claim/binding/receipt/header/chunks transaction back.

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
  "$ATTESTATION_MIGRATION"; do
  if [[ ! -f "$required_file" ]]; then
    echo "required manifest-attestation proof input is missing: $required_file" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/rank-manifest-attestation-pg17.XXXXXX)"
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

assert_generation_absent() {
  local generation_seq="$1"
  local state
  state="$(psql_cmd -Atq -v generation_seq="$generation_seq" <<'SQL'
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_claims WHERE season_id='90D' AND generation_seq=:'generation_seq'::bigint),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_manifest_bindings WHERE season_id='90D' AND generation_seq=:'generation_seq'::bigint),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_batch_receipts WHERE season_id='90D' AND generation_seq=:'generation_seq'::bigint),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_manifest_attestations WHERE season_id='90D' AND generation_seq=:'generation_seq'::bigint),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_manifest_attestation_chunks WHERE season_id='90D' AND generation_seq=:'generation_seq'::bigint)
);
SQL
)"
  if [[ "$state" != '0|0|0|0|0' ]]; then
    echo "failed attestation generation $generation_seq left durable state: $state" >&2
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
GRANT USAGE ON SCHEMA arena
  TO anon, authenticated, service_role, fixture_rogue;
SQL

psql_cmd -q -f "$FOUNDATION"
psql_cmd -q -f "$SCORER_MIGRATION"
psql_cmd -q -f "$MANIFEST_MIGRATION"

# Install the exact immutable 51000 migration-ledger evidence required by the
# real 52000 forward migration in this standalone cluster.
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
psql_cmd -q -f "$WRITER_MIGRATION"
if ! psql_cmd -q -f "$ATTESTATION_MIGRATION" >"$ERROR_FILE" 2>&1; then
  echo 'manifest attestation migration failed after the real dependency chain' >&2
  sed -n '1,260p' "$ERROR_FILE" >&2
  exit 1
fi

# Seal one real score-input manifest, then expose two test-only owner helpers:
# one creates the immutable generation authority, and the other derives real
# per-row field commitments plus exact chunk/plan hashes.  These helpers live
# only inside this disposable cluster; no production writer surface is added.
psql_cmd -q <<'SQL'
CREATE TABLE arena.fixture_rank_manifest_attestation_context (
  manifest_id uuid PRIMARY KEY,
  manifest_digest text NOT NULL,
  manifest_valid_until timestamptz NOT NULL
);

DO $fixture_manifest$
DECLARE
  v_seal jsonb;
BEGIN
  v_seal := arena.seal_leaderboard_score_input_manifest_v1(
    '90D',
    pg_catalog.repeat('a', 64),
    pg_catalog.repeat('b', 64),
    pg_catalog.repeat('c', 64),
    pg_catalog.jsonb_build_object(
      'contract', 'fixture-source-evidence@1',
      'sourceCount', 1,
      'sources', pg_catalog.jsonb_build_array('alpha')
    ),
    'leaderboard-enrichment-evidence@1',
    pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-enrichment-evidence@1',
      'rows', 2
    ),
    'leaderboard-eligibility-evidence@1',
    pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-eligibility-evidence@1',
      'canonicalIdentityCollisionCount', 0,
      'included', pg_catalog.jsonb_build_array(
        'alpha:trader-000001',
        'alpha:trader-000002'
      )
    ),
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'source', 'alpha',
        'source_trader_id', 'trader-000001',
        'roi', 30,
        'pnl', 12000,
        'max_drawdown', 8,
        'win_rate', 66,
        'sharpe_ratio', 2.2,
        'profit_factor', 2.1,
        'trades_count', 140
      ),
      pg_catalog.jsonb_build_object(
        'source', 'alpha',
        'source_trader_id', 'trader-000002',
        'roi', 18,
        'pnl', 8000,
        'max_drawdown', 14,
        'win_rate', 58,
        'sharpe_ratio', 1.5,
        'profit_factor', 1.6,
        'trades_count', 90
      )
    ),
    pg_catalog.clock_timestamp() + interval '1 hour'
  );

  INSERT INTO arena.fixture_rank_manifest_attestation_context (
    manifest_id,
    manifest_digest,
    manifest_valid_until
  ) VALUES (
    (v_seal->>'manifestId')::uuid,
    v_seal->>'manifestDigest',
    (v_seal->>'validUntil')::timestamptz
  );
END
$fixture_manifest$;

CREATE FUNCTION arena.fixture_reseal_rank_manifest_until(
  p_valid_until timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_manifest jsonb;
BEGIN
  SELECT stored.manifest
  INTO STRICT v_manifest
  FROM arena.fixture_rank_manifest_attestation_context AS fixture
  JOIN arena.leaderboard_score_input_manifests AS stored
    ON stored.manifest_id = fixture.manifest_id;

  RETURN arena.seal_leaderboard_score_input_manifest_v1(
    v_manifest->>'period',
    v_manifest->'source'->>'sourceBundleDigest',
    v_manifest->'source'->>'scoreRowsDigest',
    v_manifest->'source'->>'physicalBoardsDigest',
    v_manifest->'source'->'evidence',
    v_manifest->'enrichment'->>'contract',
    v_manifest->'enrichment'->'evidence',
    v_manifest->'eligibility'->>'contract',
    v_manifest->'eligibility'->'evidence',
    v_manifest->'inputs',
    p_valid_until
  );
END;
$body$;

CREATE FUNCTION arena.fixture_seed_manifest_attestation_authority(
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_positive_count integer,
  p_completed_at timestamptz,
  p_include_receipt boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_context arena.fixture_rank_manifest_attestation_context%ROWTYPE;
  v_claimed_at timestamptz := pg_catalog.clock_timestamp();
  v_receipt_rows integer := least(p_positive_count, 1000);
BEGIN
  SELECT fixture.*
  INTO STRICT v_context
  FROM arena.fixture_rank_manifest_attestation_context AS fixture;

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
    '90D',
    p_generation_seq,
    p_score_cohort_id,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.concat_ws(':', 'fixture-write-set', p_generation_seq),
          'UTF8'
        )
      ),
      'hex'
    ),
    p_positive_count,
    (p_positive_count + 999) / 1000,
    p_completed_at,
    300,
    v_claimed_at,
    v_claimed_at + interval '300 seconds'
  );

  INSERT INTO arena.leaderboard_rank_generation_manifest_bindings (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    score_input_manifest_id,
    score_input_manifest_digest,
    bound_at
  ) VALUES (
    'leaderboard-rank-generation-manifest-binding@1',
    '90D',
    p_generation_seq,
    p_score_cohort_id,
    v_context.manifest_id,
    v_context.manifest_digest,
    p_completed_at
  );

  IF p_include_receipt THEN
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
    ) VALUES (
      'leaderboard-rank-generation-batch-receipt@1',
      '90D',
      p_generation_seq,
      p_score_cohort_id,
      0,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.concat_ws(':', 'fixture-batch-zero', p_generation_seq),
            'UTF8'
          )
        ),
        'hex'
      ),
      v_context.manifest_id,
      v_context.manifest_digest,
      v_receipt_rows,
      1,
      'alpha',
      'trader-000001',
      'alpha',
      'trader-' || pg_catalog.to_char(v_receipt_rows, 'FM000000'),
      p_completed_at
    );
  END IF;
END;
$body$;

CREATE FUNCTION arena.fixture_insert_manifest_attestation(
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_positive_count integer,
  p_attested_at timestamptz,
  p_fault text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_context arena.fixture_rank_manifest_attestation_context%ROWTYPE;
  v_chunk_count integer := (p_positive_count + 999) / 1000;
  v_chunk_index integer;
  v_first_position integer;
  v_row_count integer;
  v_chunk_cohort_id uuid;
  v_source text;
  v_source_trader_id text;
  v_identities jsonb;
  v_commitments jsonb;
  v_chunk_sha256 text;
  v_chunks_sha256 text;
  v_chunk_plan jsonb := '[]'::jsonb;
  v_chunk_cohorts uuid[] := ARRAY[]::uuid[];
  v_chunk_identities jsonb[] := ARRAY[]::jsonb[];
  v_chunk_commitments jsonb[] := ARRAY[]::jsonb[];
  v_chunk_hashes text[] := ARRAY[]::text[];
BEGIN
  SELECT fixture.*
  INTO STRICT v_context
  FROM arena.fixture_rank_manifest_attestation_context AS fixture;

  IF p_fault IS NOT NULL AND p_fault NOT IN (
    'missing_chunk',
    'tampered_commitment',
    'bad_chunk_hash',
    'bad_header_hash',
    'invalid_identity',
    'bound_identity_mismatch',
    'within_chunk_order',
    'cross_chunk_order',
    'manifest_freshness'
  ) THEN
    RAISE EXCEPTION 'unknown fixture fault: %', p_fault;
  END IF;

  FOR v_chunk_index IN 0..(v_chunk_count - 1) LOOP
    v_first_position := v_chunk_index * 1000 + 1;
    v_row_count := least(
      1000,
      p_positive_count - v_chunk_index * 1000
    );
    v_chunk_cohort_id := CASE
      WHEN p_fault = 'bound_identity_mismatch' AND v_chunk_index = 0 THEN
        '29011000-0000-4000-8000-999999999999'::uuid
      ELSE p_score_cohort_id
    END;

    SELECT
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          generated.source,
          generated.source_trader_id
        )
        ORDER BY generated.position
      ),
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(
          arena.build_leaderboard_rank_manifest_field_commitment_v1(
            generated.source,
            generated.source_trader_id,
            12.3400,
            1234.56,
            67.89,
            12.34,
            1.2345,
            2.3456,
            42,
            88.88,
            pg_catalog.jsonb_build_object(
              'roi', 0.8,
              'pnl', 0.7,
              'drawdown', 0.9,
              'sharpe', 0.6,
              'consistency', 0.5
            ),
            74.00,
            75.00,
            50.00
          )
        )
        ORDER BY generated.position
      )
    INTO STRICT v_identities, v_commitments
    FROM (
      SELECT
        position,
        CASE
          WHEN p_fault = 'invalid_identity'
               AND v_chunk_index = 0
               AND position = v_first_position THEN 'Alpha'
          WHEN p_fault = 'cross_chunk_order'
               AND v_chunk_index = 0 THEN 'beta'
          ELSE 'alpha'
        END AS source,
        CASE
          WHEN p_fault = 'within_chunk_order'
               AND v_chunk_index = 0
               AND position = v_first_position THEN
            'trader-' || pg_catalog.to_char(position + 1, 'FM000000')
          WHEN p_fault = 'within_chunk_order'
               AND v_chunk_index = 0
               AND position = v_first_position + 1 THEN
            'trader-' || pg_catalog.to_char(position - 1, 'FM000000')
          ELSE 'trader-' || pg_catalog.to_char(position, 'FM000000')
        END AS source_trader_id
      FROM pg_catalog.generate_series(
        v_first_position,
        v_first_position + v_row_count - 1
      ) AS position
    ) AS generated;

    v_chunk_sha256 :=
      arena.build_leaderboard_rank_manifest_chunk_sha256_v1(
        '90D',
        p_generation_seq,
        v_chunk_cohort_id,
        v_context.manifest_id,
        v_context.manifest_digest,
        v_chunk_index,
        v_first_position,
        v_row_count,
        v_identities,
        v_commitments
      );

    IF p_fault = 'tampered_commitment' AND v_chunk_index = 0 THEN
      v_commitments := pg_catalog.jsonb_set(
        v_commitments,
        ARRAY['0'],
        pg_catalog.to_jsonb(pg_catalog.repeat('f', 64)),
        false
      );
    ELSIF p_fault = 'bad_chunk_hash' AND v_chunk_index = 0 THEN
      v_chunk_sha256 := CASE
        WHEN pg_catalog.left(v_chunk_sha256, 1) = '0' THEN
          '1' || pg_catalog.substr(v_chunk_sha256, 2)
        ELSE '0' || pg_catalog.substr(v_chunk_sha256, 2)
      END;
    END IF;

    v_chunk_cohorts := pg_catalog.array_append(
      v_chunk_cohorts,
      v_chunk_cohort_id
    );
    v_chunk_identities := pg_catalog.array_append(
      v_chunk_identities,
      v_identities
    );
    v_chunk_commitments := pg_catalog.array_append(
      v_chunk_commitments,
      v_commitments
    );
    v_chunk_hashes := pg_catalog.array_append(
      v_chunk_hashes,
      v_chunk_sha256
    );
    v_chunk_plan := v_chunk_plan || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_array(
        v_chunk_index,
        v_first_position,
        v_row_count,
        v_chunk_sha256
      )
    );
  END LOOP;

  v_chunks_sha256 :=
    arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
      '90D',
      p_generation_seq,
      p_score_cohort_id,
      v_context.manifest_id,
      v_context.manifest_digest,
      p_positive_count,
      v_chunk_count,
      v_chunk_plan
    );
  IF p_fault = 'bad_header_hash' THEN
    v_chunks_sha256 := CASE
      WHEN pg_catalog.left(v_chunks_sha256, 1) = '0' THEN
        '1' || pg_catalog.substr(v_chunks_sha256, 2)
      ELSE '0' || pg_catalog.substr(v_chunks_sha256, 2)
    END;
  END IF;

  INSERT INTO arena.leaderboard_rank_manifest_attestations (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    score_input_manifest_id,
    score_input_manifest_digest,
    batch_index,
    manifest_valid_until,
    positive_count,
    chunk_count,
    chunks_sha256,
    attested_at
  ) VALUES (
    'leaderboard-rank-manifest-attestation@1',
    '90D',
    p_generation_seq,
    p_score_cohort_id,
    v_context.manifest_id,
    v_context.manifest_digest,
    0,
    CASE WHEN p_fault = 'manifest_freshness'
      THEN v_context.manifest_valid_until - interval '1 microsecond'
      ELSE v_context.manifest_valid_until
    END,
    p_positive_count,
    v_chunk_count,
    v_chunks_sha256,
    p_attested_at
  );

  FOR v_chunk_index IN 0..(v_chunk_count - 1) LOOP
    IF p_fault = 'missing_chunk'
       AND v_chunk_index = v_chunk_count - 1 THEN
      CONTINUE;
    END IF;
    v_first_position := v_chunk_index * 1000 + 1;
    v_row_count := least(
      1000,
      p_positive_count - v_chunk_index * 1000
    );
    INSERT INTO arena.leaderboard_rank_manifest_attestation_chunks (
      contract,
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest,
      chunk_index,
      first_position,
      row_count,
      identities,
      field_commitments,
      chunk_sha256
    ) VALUES (
      'leaderboard-rank-manifest-attestation-chunk@1',
      '90D',
      p_generation_seq,
      v_chunk_cohorts[v_chunk_index + 1],
      v_context.manifest_id,
      v_context.manifest_digest,
      v_chunk_index,
      v_first_position,
      v_row_count,
      v_chunk_identities[v_chunk_index + 1],
      v_chunk_commitments[v_chunk_index + 1],
      v_chunk_hashes[v_chunk_index + 1]
    );
  END LOOP;
END;
$body$;
SQL

# Happy paths: the exact claim, manifest binding, batch-zero receipt, header,
# and all chunks are born in one transaction.  Exercise both topology shapes.
psql_cmd -q <<'SQL'
DO $one_chunk$
DECLARE
  v_completed_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM arena.fixture_seed_manifest_attestation_authority(
    1,
    '29011000-0000-4000-8000-000000000001'::uuid,
    2,
    v_completed_at
  );
  PERFORM arena.fixture_insert_manifest_attestation(
    1,
    '29011000-0000-4000-8000-000000000001'::uuid,
    2,
    v_completed_at
  );
END
$one_chunk$;

DO $two_chunks$
DECLARE
  v_completed_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM arena.fixture_seed_manifest_attestation_authority(
    2,
    '29011000-0000-4000-8000-000000000002'::uuid,
    1001,
    v_completed_at
  );
  PERFORM arena.fixture_insert_manifest_attestation(
    2,
    '29011000-0000-4000-8000-000000000002'::uuid,
    1001,
    v_completed_at
  );
END
$two_chunks$;

DO $assert_happy_paths$
DECLARE
  v_state text;
  v_plan_valid boolean;
  v_chunks_valid boolean;
  v_order_valid boolean;
BEGIN
  SELECT pg_catalog.concat_ws(
    '|',
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_manifest_attestations
     WHERE season_id = '90D' AND generation_seq = 1),
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_manifest_attestation_chunks
     WHERE season_id = '90D' AND generation_seq = 1),
    (SELECT pg_catalog.sum(chunk.row_count)
     FROM arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = '90D' AND chunk.generation_seq = 1),
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_manifest_attestations
     WHERE season_id = '90D' AND generation_seq = 2),
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_manifest_attestation_chunks
     WHERE season_id = '90D' AND generation_seq = 2),
    (SELECT pg_catalog.sum(chunk.row_count)
     FROM arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = '90D' AND chunk.generation_seq = 2),
    (SELECT pg_catalog.string_agg(
       pg_catalog.concat_ws(
         ':',
         chunk.chunk_index,
         chunk.first_position,
         chunk.row_count
       ),
       ',' ORDER BY chunk.chunk_index
     )
     FROM arena.leaderboard_rank_manifest_attestation_chunks AS chunk
     WHERE chunk.season_id = '90D' AND chunk.generation_seq = 2)
  ) INTO STRICT v_state;
  IF v_state IS DISTINCT FROM '1|1|2|1|2|1001|0:1:1000,1:1001:1' THEN
    RAISE EXCEPTION 'valid attestation topology drifted: %', v_state;
  END IF;

  SELECT header.chunks_sha256 =
    arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
      header.season_id,
      header.generation_seq,
      header.score_cohort_id,
      header.score_input_manifest_id,
      header.score_input_manifest_digest,
      header.positive_count,
      header.chunk_count,
      plan.chunk_plan
    )
  INTO STRICT v_plan_valid
  FROM arena.leaderboard_rank_manifest_attestations AS header
  CROSS JOIN LATERAL (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        chunk.chunk_index,
        chunk.first_position,
        chunk.row_count,
        chunk.chunk_sha256
      )
      ORDER BY chunk.chunk_index
    ) AS chunk_plan
    FROM arena.leaderboard_rank_manifest_attestation_chunks AS chunk
    WHERE chunk.season_id = header.season_id
      AND chunk.generation_seq = header.generation_seq
  ) AS plan
  WHERE header.season_id = '90D' AND header.generation_seq = 2;

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
  FROM arena.leaderboard_rank_manifest_attestation_chunks AS chunk
  WHERE chunk.season_id = '90D' AND chunk.generation_seq = 2;

  WITH flattened AS (
    SELECT
      chunk.chunk_index,
      identity.ordinality,
      identity.value->>0 AS source,
      identity.value->>1 AS source_trader_id
    FROM arena.leaderboard_rank_manifest_attestation_chunks AS chunk
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(chunk.identities)
      WITH ORDINALITY AS identity(value, ordinality)
    WHERE chunk.season_id = '90D' AND chunk.generation_seq = 2
  ), ordered AS (
    SELECT
      flattened.*,
      pg_catalog.lag(ROW(
        flattened.source COLLATE pg_catalog."C",
        flattened.source_trader_id COLLATE pg_catalog."C"
      )) OVER (ORDER BY flattened.chunk_index, flattened.ordinality)
        AS prior_identity
    FROM flattened
  )
  SELECT NOT pg_catalog.bool_or(
    ordered.prior_identity IS NOT NULL
    AND ordered.prior_identity >= ROW(
      ordered.source COLLATE pg_catalog."C",
      ordered.source_trader_id COLLATE pg_catalog."C"
    )
  )
  INTO STRICT v_order_valid
  FROM ordered;

  IF v_plan_valid IS DISTINCT FROM true
     OR v_chunks_valid IS DISTINCT FROM true
     OR v_order_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'valid attestation evidence did not recompute: plan %, chunks %, order %',
      v_plan_valid,
      v_chunks_valid,
      v_order_valid;
  END IF;
END
$assert_happy_paths$;
SQL

# Precommitting otherwise exact authority must not authorize a later header:
# the binding and receipt xmin are part of the deferred completeness proof.
psql_cmd -q <<'SQL'
SELECT arena.fixture_seed_manifest_attestation_authority(
  3,
  '29011000-0000-4000-8000-000000000003'::uuid,
  2,
  pg_catalog.clock_timestamp()
);
SQL
expect_failure \
  'delayed attestation over old binding and receipt' \
  'current-transaction binding and batch-zero receipt' \
  "SELECT arena.fixture_insert_manifest_attestation(
     3,
     '29011000-0000-4000-8000-000000000003'::uuid,
     2,
     (SELECT completed_at
      FROM arena.leaderboard_rank_generation_batch_receipts
      WHERE season_id='90D' AND generation_seq=3 AND batch_index=0)
   );"

delayed_state="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_claims WHERE season_id='90D' AND generation_seq=3),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_manifest_bindings WHERE season_id='90D' AND generation_seq=3),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_batch_receipts WHERE season_id='90D' AND generation_seq=3),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_manifest_attestations WHERE season_id='90D' AND generation_seq=3),
  (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_manifest_attestation_chunks WHERE season_id='90D' AND generation_seq=3)
);
SQL
)"
if [[ "$delayed_state" != '1|1|1|0|0' ]]; then
  echo "delayed attestation left an invalid durability shape: $delayed_state" >&2
  exit 1
fi

# A deferred missing-chunk failure must roll back every authority row created
# in the transaction, not merely reject or remove the incomplete header.
expect_failure \
  'missing final attestation chunk' \
  'manifest attestation chunk population is incomplete' \
  "DO \$case\$
   DECLARE v_completed_at timestamptz := pg_catalog.clock_timestamp();
   BEGIN
     PERFORM arena.fixture_seed_manifest_attestation_authority(
       4,
       '29011000-0000-4000-8000-000000000004'::uuid,
       1001,
       v_completed_at
     );
     PERFORM arena.fixture_insert_manifest_attestation(
       4,
       '29011000-0000-4000-8000-000000000004'::uuid,
       1001,
       v_completed_at,
       'missing_chunk'
     );
   END
   \$case\$;"
assert_generation_absent 4

# Both evidence relations are append-once.  Header-commit xmin closes the
# chunk set, while the shared mutation fence rejects all later rewrites.
expect_failure \
  'append chunk after header commit' \
  'manifest attestation chunks are immutable after header commit' \
  "INSERT INTO arena.leaderboard_rank_manifest_attestation_chunks (
     contract, season_id, generation_seq, score_cohort_id,
     score_input_manifest_id, score_input_manifest_digest,
     chunk_index, first_position, row_count, identities,
     field_commitments, chunk_sha256
   )
   SELECT
     contract, season_id, generation_seq, score_cohort_id,
     score_input_manifest_id, score_input_manifest_digest,
     1, 1001, row_count, identities, field_commitments, chunk_sha256
   FROM arena.leaderboard_rank_manifest_attestation_chunks
   WHERE season_id='90D' AND generation_seq=1 AND chunk_index=0;"

expect_failure \
  'update attestation header' \
  'leaderboard publication receipts are immutable' \
  "UPDATE arena.leaderboard_rank_manifest_attestations
   SET positive_count=positive_count
   WHERE season_id='90D' AND generation_seq=1;"
expect_failure \
  'delete attestation header' \
  'leaderboard publication receipts are immutable' \
  "DELETE FROM arena.leaderboard_rank_manifest_attestations
   WHERE season_id='90D' AND generation_seq=1;"
expect_failure \
  'truncate attestation headers and chunks' \
  'leaderboard publication receipts are immutable' \
  'TRUNCATE arena.leaderboard_rank_manifest_attestations,
     arena.leaderboard_rank_manifest_attestation_chunks;'
expect_failure \
  'update attestation chunk' \
  'leaderboard publication receipts are immutable' \
  "UPDATE arena.leaderboard_rank_manifest_attestation_chunks
   SET row_count=row_count
   WHERE season_id='90D' AND generation_seq=1 AND chunk_index=0;"
expect_failure \
  'delete attestation chunk' \
  'leaderboard publication receipts are immutable' \
  "DELETE FROM arena.leaderboard_rank_manifest_attestation_chunks
   WHERE season_id='90D' AND generation_seq=1 AND chunk_index=0;"
expect_failure \
  'truncate attestation chunks' \
  'leaderboard publication receipts are immutable' \
  'TRUNCATE arena.leaderboard_rank_manifest_attestation_chunks;'

# Every malformed case below creates its claim, binding, receipt, header and
# chunks in one implicit transaction.  A failure is accepted only when that
# entire authority graph disappears afterward.
run_atomic_fault_case() {
  local generation_seq="$1"
  local label="$2"
  local pattern="$3"
  local positive_count="$4"
  local fault="$5"
  local cohort
  cohort="$(printf '29011000-0000-4000-8000-%012d' "$generation_seq")"
  expect_failure \
    "$label" \
    "$pattern" \
    "DO \$case\$
     DECLARE v_completed_at timestamptz := pg_catalog.clock_timestamp();
     BEGIN
       PERFORM arena.fixture_seed_manifest_attestation_authority(
         $generation_seq,
         '$cohort'::uuid,
         $positive_count,
         v_completed_at
       );
       PERFORM arena.fixture_insert_manifest_attestation(
         $generation_seq,
         '$cohort'::uuid,
         $positive_count,
         v_completed_at,
         '$fault'
       );
     END
     \$case\$;"
  assert_generation_absent "$generation_seq"
}

run_atomic_fault_case \
  5 \
  'tampered field commitment without a new chunk hash' \
  'rank_manifest_attestation_chunk_content_check' \
  2 \
  'tampered_commitment'
run_atomic_fault_case \
  6 \
  'forged chunk hash' \
  'rank_manifest_attestation_chunk_content_check' \
  2 \
  'bad_chunk_hash'
run_atomic_fault_case \
  7 \
  'forged header plan hash' \
  'manifest attestation chunk plan digest is invalid' \
  2 \
  'bad_header_hash'
run_atomic_fault_case \
  8 \
  'noncanonical manifest identity' \
  'manifest field identity is invalid' \
  2 \
  'invalid_identity'
run_atomic_fault_case \
  9 \
  'chunk identity does not match its bound header' \
  'manifest attestation chunk has no exact current header' \
  2 \
  'bound_identity_mismatch'
run_atomic_fault_case \
  10 \
  'identity order regresses within one chunk' \
  'manifest attestation chunk content is invalid' \
  2 \
  'within_chunk_order'
run_atomic_fault_case \
  11 \
  'identity order regresses across chunks' \
  'manifest attestation identity order is not globally strict' \
  1001 \
  'cross_chunk_order'

# Derived score commitments are recomputed from the exact factor payload.  A
# caller cannot round or substitute the three persisted derived metrics.
expect_failure \
  'wrong manifest-derived profitability score' \
  'manifest-derived score commitment is invalid' \
  "DO \$case\$
   DECLARE
     v_completed_at timestamptz := pg_catalog.clock_timestamp();
   BEGIN
     PERFORM arena.fixture_seed_manifest_attestation_authority(
       12,
       '29011000-0000-4000-8000-000000000012'::uuid,
       2,
       v_completed_at
     );
     PERFORM arena.build_leaderboard_rank_manifest_field_commitment_v1(
       'alpha',
       'trader-000001',
       12.3400,
       1234.56,
       67.89,
       12.34,
       1.2345,
       2.3456,
       42,
       88.88,
       pg_catalog.jsonb_build_object(
         'roi', 0.8,
         'pnl', 0.7,
         'drawdown', 0.9,
         'sharpe', 0.6,
         'consistency', 0.5
       ),
       73.00,
       75.00,
       50.00
     );
   END
   \$case\$;"
assert_generation_absent 12

# Receipt presence alone is insufficient: completed_at is bound byte-for-byte
# to attested_at by the deferred completeness trigger.
expect_failure \
  'batch-zero receipt timestamp does not match attestation' \
  'current-transaction binding and batch-zero receipt' \
  "DO \$case\$
   DECLARE
     v_completed_at timestamptz := pg_catalog.clock_timestamp();
   BEGIN
     PERFORM arena.fixture_seed_manifest_attestation_authority(
       13,
       '29011000-0000-4000-8000-000000000013'::uuid,
       2,
       v_completed_at
     );
     PERFORM arena.fixture_insert_manifest_attestation(
       13,
       '29011000-0000-4000-8000-000000000013'::uuid,
       2,
       v_completed_at + interval '1 microsecond'
     );
   END
   \$case\$;"
assert_generation_absent 13

run_atomic_fault_case \
  14 \
  'attestation changes the sealed manifest validity boundary' \
  'manifest attestation lacks its exact live source manifest' \
  2 \
  'manifest_freshness'

# The prior case proves exact validUntil identity.  This distinct case seals a
# genuinely short-lived manifest, binds all authority while it is live, then
# crosses its TTL before the deferred completeness check runs at commit.
expect_failure \
  'source manifest expires before attestation commit' \
  'manifest attestation lacks its exact live source manifest' \
  "DO \$case\$
   DECLARE
     v_completed_at timestamptz := pg_catalog.clock_timestamp();
     v_seal jsonb;
   BEGIN
     v_seal := arena.fixture_reseal_rank_manifest_until(
       pg_catalog.clock_timestamp() + interval '2 seconds'
     );
     UPDATE arena.fixture_rank_manifest_attestation_context
     SET
       manifest_id = (v_seal->>'manifestId')::uuid,
       manifest_digest = v_seal->>'manifestDigest',
       manifest_valid_until = (v_seal->>'validUntil')::timestamptz;

     PERFORM arena.fixture_seed_manifest_attestation_authority(
       15,
       '29011000-0000-4000-8000-000000000015'::uuid,
       2,
       v_completed_at
     );
     PERFORM arena.fixture_insert_manifest_attestation(
       15,
       '29011000-0000-4000-8000-000000000015'::uuid,
       2,
       v_completed_at
     );
     PERFORM pg_catalog.pg_sleep(2.2);
   END
   \$case\$;"
assert_generation_absent 15

expired_manifest_state="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.concat_ws(
  '|',
  (SELECT pg_catalog.count(*)
   FROM arena.leaderboard_score_input_manifests),
  (SELECT pg_catalog.count(*)
   FROM arena.fixture_rank_manifest_attestation_context AS fixture
   JOIN arena.leaderboard_score_input_manifests AS stored
     ON stored.manifest_id = fixture.manifest_id
   WHERE stored.valid_until > pg_catalog.clock_timestamp())
);
SQL
)"
if [[ "$expired_manifest_state" != '1|1' ]]; then
  echo "expired attestation left a sealed manifest behind: $expired_manifest_state" >&2
  exit 1
fi

# The substrate is deliberately owner-only.  Prove denial behavior as the
# production API role as well as catalog-level absence of effective rights for
# every API/rogue role in this standalone cluster.
expect_failure \
  'service role cannot read attestation headers' \
  'permission denied for table leaderboard_rank_manifest_attestations' \
  'SET ROLE service_role;
   SELECT * FROM arena.leaderboard_rank_manifest_attestations;'
expect_failure \
  'service role cannot write attestation chunks' \
  'permission denied for table leaderboard_rank_manifest_attestation_chunks' \
  "SET ROLE service_role;
   INSERT INTO arena.leaderboard_rank_manifest_attestation_chunks (
     contract, season_id, generation_seq, score_cohort_id,
     score_input_manifest_id, score_input_manifest_digest,
     chunk_index, first_position, row_count, identities,
     field_commitments, chunk_sha256
   ) VALUES (
     'leaderboard-rank-manifest-attestation-chunk@1',
     '90D',
     99,
     '29011000-0000-4000-8000-000000000099'::uuid,
     '29011000-0000-4000-8000-000000000099'::uuid,
     pg_catalog.repeat('0', 64),
     0,
     1,
     1,
     pg_catalog.jsonb_build_array(
       pg_catalog.jsonb_build_array('alpha', 'trader-000001')
     ),
     pg_catalog.jsonb_build_array(pg_catalog.repeat('0', 64)),
     pg_catalog.repeat('0', 64)
   );"
expect_failure \
  'service role cannot execute attestation encoder' \
  'permission denied for function encode_leaderboard_rank_manifest_fields_v1' \
  "SET ROLE service_role;
   SELECT arena.encode_leaderboard_rank_manifest_fields_v1(
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, NULL, NULL
   );"

psql_cmd -q <<'SQL'
DO $assert_api_isolation$
DECLARE
  v_role name;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'anon'::name,
    'authenticated'::name,
    'service_role'::name,
    'fixture_rogue'::name
  ] LOOP
    IF pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestations',
         'SELECT'
       )
       OR pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestations',
         'INSERT'
       )
       OR pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestations',
         'UPDATE'
       )
       OR pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestations',
         'DELETE'
       )
       OR pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestation_chunks',
         'SELECT'
       )
       OR pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestation_chunks',
         'INSERT'
       )
       OR pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestation_chunks',
         'UPDATE'
       )
       OR pg_catalog.has_table_privilege(
         v_role,
         'arena.leaderboard_rank_manifest_attestation_chunks',
         'DELETE'
       )
       OR pg_catalog.has_function_privilege(
         v_role,
         'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
         'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         v_role,
         'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)',
         'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'attestation API isolation failed for role %', v_role;
    END IF;
  END LOOP;
END
$assert_api_isolation$;
SQL

# Durable attestations intentionally do not retain a raw-manifest FK.  Once
# the transaction has verified the live content-addressed manifest, that raw
# input can be pruned without weakening either immutable evidence relation.
psql_cmd -q <<'SQL'
DELETE FROM arena.leaderboard_score_input_manifests;

DO $assert_manifest_prunable$
DECLARE
  v_state text;
  v_chunks_valid boolean;
BEGIN
  SELECT pg_catalog.concat_ws(
    '|',
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_score_input_manifests),
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_manifest_attestations),
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_manifest_attestation_chunks),
    (SELECT pg_catalog.count(*)
     FROM arena.leaderboard_rank_generation_manifest_bindings)
  ) INTO STRICT v_state;
  IF v_state IS DISTINCT FROM '0|2|3|3' THEN
    RAISE EXCEPTION 'raw manifest pruning damaged durable evidence: %', v_state;
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
  FROM arena.leaderboard_rank_manifest_attestation_chunks AS chunk;
  IF v_chunks_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'pruned manifest invalidated durable chunk evidence';
  END IF;
END
$assert_manifest_prunable$;
SQL

printf '%s\n' \
  'PostgreSQL 17 manifest-attestation behavioral proof passed.'
