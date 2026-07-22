#!/usr/bin/env bash

# PostgreSQL 17 integration proof for the inert, owner-only leaderboard score
# input manifest store. It installs the real private scorer first, exercises the
# content codec/seal/verifier, and proves hostile default ACLs do not leak it.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCORER_MIGRATION="$ROOT_DIR/supabase/migrations/20260722041000_pure_arena_score_v4_scorer.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260722051000_leaderboard_score_input_manifest_contract.sql"
FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/fixtures/leaderboard-score-input-manifest-v1.json"
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

TMP_ROOT="$(mktemp -d /tmp/score-input-manifest-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 7000)))}"
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

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE leaked_default_role NOLOGIN;
CREATE SCHEMA arena;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

-- Both relation and function defaults are deliberately hostile. Each private
-- object migration must revoke every inherited non-owner grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  GRANT ALL ON TABLES TO anon, authenticated, service_role, leaked_default_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role, leaked_default_role;
SQL

psql_cmd -q -f "$SCORER_MIGRATION"

# A single leaked helper grant is enough to invalidate the scorer authority
# boundary. Prove the dependent manifest migration rejects it before install.
psql_cmd -q <<'SQL'
GRANT EXECUTE ON FUNCTION arena.arena_score_v4_round2(double precision) TO PUBLIC;
SQL
set +e
leaked_scorer_output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"
leaked_scorer_status=$?
set -e
if ((leaked_scorer_status == 0)); then
  echo "manifest migration accepted a PUBLIC scorer-helper grant" >&2
  exit 1
fi
if [[ "$leaked_scorer_output" != *"private PG17 scorer is not owner-only"* ]]; then
  echo "manifest scorer-ACL preflight failed for the wrong reason" >&2
  echo "$leaked_scorer_output" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
REVOKE ALL ON FUNCTION arena.arena_score_v4_round2(double precision) FROM PUBLIC;
SQL
psql_cmd -q -f "$MIGRATION"

psql_cmd -q -v fixture_json="$(<"$FIXTURE")" <<'SQL'
CREATE TABLE public.manifest_fixture (
  payload jsonb NOT NULL,
  concurrency_valid_until timestamp with time zone NOT NULL
);
INSERT INTO public.manifest_fixture (payload, concurrency_valid_until)
VALUES (:'fixture_json'::jsonb, pg_catalog.clock_timestamp() + interval '2 hours');

DO $catalog_acl_proof$
DECLARE
  v_table_oid oid := 'arena.leaderboard_score_input_manifests'::regclass::oid;
  v_signature text;
  v_expected_volatility "char";
BEGIN
  IF NOT (
    SELECT relation_row.relrowsecurity
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = v_table_oid
  ) THEN
    RAISE EXCEPTION 'manifest table RLS is disabled';
  END IF;

  FOR v_signature, v_expected_volatility IN
    SELECT * FROM (VALUES
      (
        'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
        's'::"char"
      ),
      (
        'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
        'v'::"char"
      ),
      ('arena.verify_leaderboard_score_input_manifest_v1(uuid)', 's'::"char")
    ) AS expected(signature, volatility)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature::regprocedure::oid
        AND (
          function_row.provolatile <> v_expected_volatility
          OR function_row.prosecdef
          OR function_row.proconfig IS NULL
          OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig))
        )
    ) THEN
      RAISE EXCEPTION 'manifest catalog contract drifted: %', v_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::regprocedure::oid
      AND (
        function_row.proconfig IS NULL
        OR NOT ('extra_float_digits=3' = ANY(function_row.proconfig))
        OR NOT ('quote_all_identifiers=off' = ANY(function_row.proconfig))
      )
  ) THEN
    RAISE EXCEPTION 'manifest encoder canonical GUC contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role', 'leaked_default_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(
      ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
    ) AS checked_privilege(privilege_name)
    WHERE pg_catalog.has_table_privilege(
      checked_role.role_name,
      'arena.leaderboard_score_input_manifests',
      checked_privilege.privilege_name
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role', 'leaked_default_role']::text[]
    ) AS checked_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY[
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
      'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
      'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
    ]::text[]) AS checked_function(signature)
    WHERE pg_catalog.has_function_privilege(
      checked_role.role_name,
      checked_function.signature,
      'EXECUTE'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation_row.relacl, pg_catalog.acldefault('r', relation_row.relowner))
    ) AS privilege_row
    WHERE relation_row.oid = v_table_oid
      AND privilege_row.grantee <> relation_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
    ) AS privilege_row
    WHERE function_row.oid IN (
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::regprocedure::oid,
      'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::regprocedure::oid,
      'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::regprocedure::oid
    )
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'private manifest object leaked a non-owner privilege';
  END IF;
END
$catalog_acl_proof$;

DO $content_addressed_proof$
DECLARE
  v_fixture jsonb := (SELECT payload FROM manifest_fixture);
  v_deadline timestamp with time zone := pg_catalog.statement_timestamp() + interval '1 hour';
  v_first jsonb;
  v_second jsonb;
  v_changed jsonb;
  v_verified jsonb;
  v_reversed_inputs jsonb;
  v_manifest jsonb;
  v_recomputed_digest text;
BEGIN
  PERFORM pg_catalog.set_config('TimeZone', 'UTC', true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', 'on', true);
  v_first := arena.seal_leaderboard_score_input_manifest_v1(
    v_fixture->>'period',
    v_fixture->>'sourceBundleDigest',
    v_fixture->>'scoreRowsDigest',
    v_fixture->>'physicalBoardsDigest',
    v_fixture->'sourceEvidence',
    v_fixture->>'enrichmentContract',
    v_fixture->'enrichmentEvidence',
    v_fixture->>'eligibilityContract',
    v_fixture->'eligibilityEvidence',
    v_fixture->'inputs',
    v_deadline
  );

  SELECT pg_catalog.jsonb_agg(input_row.value ORDER BY input_row.ordinality DESC)
  INTO STRICT v_reversed_inputs
  FROM pg_catalog.jsonb_array_elements(v_fixture->'inputs')
    WITH ORDINALITY AS input_row(value, ordinality);
  -- Parsed numeric spelling and array order must not change manifest identity.
  v_reversed_inputs := pg_catalog.jsonb_set(
    v_reversed_inputs,
    '{0,roi}',
    '18.25000'::jsonb
  );
  PERFORM pg_catalog.set_config('TimeZone', 'America/Los_Angeles', true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', 'off', true);
  v_second := arena.seal_leaderboard_score_input_manifest_v1(
    v_fixture->>'period',
    v_fixture->>'sourceBundleDigest',
    v_fixture->>'scoreRowsDigest',
    v_fixture->>'physicalBoardsDigest',
    v_fixture->'sourceEvidence',
    v_fixture->>'enrichmentContract',
    v_fixture->'enrichmentEvidence',
    v_fixture->>'eligibilityContract',
    v_fixture->'eligibilityEvidence',
    v_reversed_inputs,
    v_deadline
  );

  IF v_first->>'contract' IS DISTINCT FROM 'leaderboard-score-input-manifest-seal@1'
     OR v_first->>'manifestDigest' !~ '^[0-9a-f]{64}$'
     OR v_first->>'inputDigest' !~ '^[0-9a-f]{64}$'
     OR v_first->>'outputDigest' !~ '^[0-9a-f]{64}$'
     OR (v_first->>'inputCount')::integer <> 2
     OR v_first->>'manifestId' IS DISTINCT FROM v_second->>'manifestId'
     OR v_first->>'manifestDigest' IS DISTINCT FROM v_second->>'manifestDigest'
     OR (SELECT pg_catalog.count(*) FROM arena.leaderboard_score_input_manifests) <> 1 THEN
    RAISE EXCEPTION 'content-addressed seal was not canonical and idempotent: %, %',
      v_first, v_second;
  END IF;

  SELECT stored.manifest
  INTO STRICT v_manifest
  FROM arena.leaderboard_score_input_manifests AS stored
  WHERE stored.manifest_id = (v_first->>'manifestId')::uuid;
  v_recomputed_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to((v_manifest - 'manifestDigest')::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  IF v_manifest->>'manifestDigest' IS DISTINCT FROM v_recomputed_digest
     OR v_manifest->'inputs'->0->>'source' IS DISTINCT FROM 'binance_futures'
     OR v_manifest->'inputs'->1->>'source' IS DISTINCT FROM 'bybit'
     OR v_manifest->'scorer'->>'contract' IS DISTINCT FROM 'arena-score-v4-pg17@1'
     OR v_manifest->'scorer'->>'definitionContract'
        IS DISTINCT FROM 'arena-score-v4-pg17-definition@1'
     OR v_manifest->'scorer'->>'definitionDigest' !~ '^[0-9a-f]{64}$'
     OR v_manifest->'source'->>'evidenceDigest' !~ '^[0-9a-f]{64}$'
     OR v_manifest->'enrichment'->>'evidenceDigest' !~ '^[0-9a-f]{64}$'
     OR v_manifest->'eligibility'->>'evidenceDigest' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'stored manifest basis or canonical order drifted: %', v_manifest;
  END IF;

  v_verified := arena.verify_leaderboard_score_input_manifest_v1(
    (v_first->>'manifestId')::uuid
  );
  IF v_verified->>'contract'
       IS DISTINCT FROM 'leaderboard-score-input-manifest-verification@1'
     OR (v_verified->>'contentValid')::boolean IS DISTINCT FROM true
     OR (v_verified->>'valid')::boolean IS DISTINCT FROM true
     OR (v_verified->>'expired')::boolean IS DISTINCT FROM false
     OR v_verified->>'manifestDigest' IS DISTINCT FROM v_first->>'manifestDigest' THEN
    RAISE EXCEPTION 'fresh manifest verification failed: %', v_verified;
  END IF;

  -- Changing bound enrichment evidence must create a different content ID.
  v_changed := arena.seal_leaderboard_score_input_manifest_v1(
    v_fixture->>'period',
    v_fixture->>'sourceBundleDigest',
    v_fixture->>'scoreRowsDigest',
    v_fixture->>'physicalBoardsDigest',
    v_fixture->'sourceEvidence',
    v_fixture->>'enrichmentContract',
    pg_catalog.jsonb_set(
      v_fixture->'enrichmentEvidence',
      '{asOf}',
      '"2026-07-22T04:33:00Z"'::jsonb
    ),
    v_fixture->>'eligibilityContract',
    v_fixture->'eligibilityEvidence',
    v_fixture->'inputs',
    v_deadline
  );
  IF v_changed->>'manifestId' = v_first->>'manifestId'
     OR v_changed->>'manifestDigest' = v_first->>'manifestDigest'
     OR (SELECT pg_catalog.count(*) FROM arena.leaderboard_score_input_manifests) <> 2 THEN
    RAISE EXCEPTION 'evidence change did not change manifest identity';
  END IF;

  -- Owner-level storage corruption must be detected by recomputing the scorer
  -- and every digest. Each exception block rolls its update back.
  BEGIN
    UPDATE arena.leaderboard_score_input_manifests
    SET manifest = pg_catalog.jsonb_set(manifest, '{outputs,0,totalScore}', '99'::jsonb)
    WHERE manifest_id = (v_first->>'manifestId')::uuid;
    PERFORM arena.verify_leaderboard_score_input_manifest_v1(
      (v_first->>'manifestId')::uuid
    );
    RAISE EXCEPTION 'tampered scorer output unexpectedly verified';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE arena.leaderboard_score_input_manifests
    SET manifest = pg_catalog.jsonb_set(
      manifest,
      '{eligibility,evidence,canonicalIdentityCollisionCount}',
      '1'::jsonb
    )
    WHERE manifest_id = (v_first->>'manifestId')::uuid;
    PERFORM arena.verify_leaderboard_score_input_manifest_v1(
      (v_first->>'manifestId')::uuid
    );
    RAISE EXCEPTION 'tampered eligibility evidence unexpectedly verified';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE arena.leaderboard_score_input_manifests
    SET manifest = pg_catalog.jsonb_set(
      manifest,
      '{scorer,definitionDigest}',
      pg_catalog.to_jsonb(pg_catalog.repeat('0', 64))
    )
    WHERE manifest_id = (v_first->>'manifestId')::uuid;
    PERFORM arena.verify_leaderboard_score_input_manifest_v1(
      (v_first->>'manifestId')::uuid
    );
    RAISE EXCEPTION 'tampered scorer definition unexpectedly verified';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$content_addressed_proof$;

DO $invalid_input_proof$
DECLARE
  v_fixture jsonb := (SELECT payload FROM manifest_fixture);
BEGIN
  BEGIN
    INSERT INTO arena.leaderboard_score_input_manifests (
      manifest_digest,
      period,
      manifest,
      valid_until
    ) VALUES (
      pg_catalog.repeat('a', 64),
      '90D',
      '{}'::jsonb,
      pg_catalog.statement_timestamp() + interval '1 hour'
    );
    RAISE EXCEPTION 'null-valued scalar binding unexpectedly passed CHECK';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM arena.seal_leaderboard_score_input_manifest_v1(
      v_fixture->>'period',
      v_fixture->>'sourceBundleDigest',
      v_fixture->>'scoreRowsDigest',
      v_fixture->>'physicalBoardsDigest',
      v_fixture->'sourceEvidence',
      v_fixture->>'enrichmentContract',
      v_fixture->'enrichmentEvidence',
      v_fixture->>'eligibilityContract',
      v_fixture->'eligibilityEvidence',
      v_fixture->'inputs',
      pg_catalog.clock_timestamp() + interval '100 milliseconds'
    );
    RAISE EXCEPTION 'nearly expired manifest unexpectedly sealed';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM arena.seal_leaderboard_score_input_manifest_v1(
      v_fixture->>'period',
      'ABC',
      v_fixture->>'scoreRowsDigest',
      v_fixture->>'physicalBoardsDigest',
      v_fixture->'sourceEvidence',
      v_fixture->>'enrichmentContract',
      v_fixture->'enrichmentEvidence',
      v_fixture->>'eligibilityContract',
      v_fixture->'eligibilityEvidence',
      v_fixture->'inputs',
      pg_catalog.statement_timestamp() + interval '1 hour'
    );
    RAISE EXCEPTION 'invalid digest unexpectedly sealed';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM arena.seal_leaderboard_score_input_manifest_v1(
      v_fixture->>'period',
      v_fixture->>'sourceBundleDigest',
      v_fixture->>'scoreRowsDigest',
      v_fixture->>'physicalBoardsDigest',
      v_fixture->'sourceEvidence',
      'Invalid Contract',
      v_fixture->'enrichmentEvidence',
      v_fixture->>'eligibilityContract',
      v_fixture->'eligibilityEvidence',
      v_fixture->'inputs',
      pg_catalog.statement_timestamp() + interval '1 hour'
    );
    RAISE EXCEPTION 'invalid evidence contract unexpectedly sealed';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM arena.seal_leaderboard_score_input_manifest_v1(
      v_fixture->>'period',
      v_fixture->>'sourceBundleDigest',
      v_fixture->>'scoreRowsDigest',
      v_fixture->>'physicalBoardsDigest',
      v_fixture->'sourceEvidence',
      v_fixture->>'enrichmentContract',
      v_fixture->'enrichmentEvidence',
      v_fixture->>'eligibilityContract',
      v_fixture->'eligibilityEvidence',
      v_fixture->'inputs',
      pg_catalog.statement_timestamp() + interval '25 hours'
    );
    RAISE EXCEPTION 'overlong manifest validity unexpectedly sealed';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$invalid_input_proof$;

DO $expiry_semantics_proof$
DECLARE
  v_fixture jsonb := (SELECT payload FROM manifest_fixture);
  v_expired_at timestamp with time zone := pg_catalog.statement_timestamp() - interval '1 hour';
  v_basis jsonb;
  v_digest text;
  v_manifest jsonb;
  v_id uuid;
  v_verified jsonb;
BEGIN
  v_basis := arena.encode_leaderboard_score_input_manifest_v1(
    v_fixture->>'period',
    v_fixture->>'sourceBundleDigest',
    v_fixture->>'scoreRowsDigest',
    v_fixture->>'physicalBoardsDigest',
    v_fixture->'sourceEvidence',
    v_fixture->>'enrichmentContract',
    v_fixture->'enrichmentEvidence',
    v_fixture->>'eligibilityContract',
    v_fixture->'eligibilityEvidence',
    v_fixture->'inputs',
    v_expired_at
  );
  v_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_manifest := v_basis || pg_catalog.jsonb_build_object(
    'manifestDigest', v_digest
  );
  INSERT INTO arena.leaderboard_score_input_manifests (
    manifest_digest,
    period,
    manifest,
    valid_until
  ) VALUES (
    v_digest,
    v_fixture->>'period',
    v_manifest,
    v_expired_at
  ) RETURNING manifest_id INTO STRICT v_id;

  v_verified := arena.verify_leaderboard_score_input_manifest_v1(v_id);
  IF (v_verified->>'contentValid')::boolean IS DISTINCT FROM true
     OR (v_verified->>'valid')::boolean IS DISTINCT FROM false
     OR (v_verified->>'expired')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'expired manifest validity semantics drifted: %', v_verified;
  END IF;
END
$expiry_semantics_proof$;
SQL

concurrent_seal() {
  psql_cmd -Atq <<'SQL'
SELECT arena.seal_leaderboard_score_input_manifest_v1(
  fixture.payload->>'period',
  fixture.payload->>'sourceBundleDigest',
  fixture.payload->>'scoreRowsDigest',
  fixture.payload->>'physicalBoardsDigest',
  fixture.payload->'sourceEvidence',
  fixture.payload->>'enrichmentContract',
  fixture.payload->'enrichmentEvidence',
  fixture.payload->>'eligibilityContract',
  fixture.payload->'eligibilityEvidence',
  fixture.payload->'inputs',
  fixture.concurrency_valid_until
)->>'manifestId'
FROM public.manifest_fixture AS fixture;
SQL
}

wait_for_advisory_lock() {
  local lock_key="$1"
  local attempt
  local visible
  for ((attempt = 0; attempt < 200; attempt++)); do
    visible="$(psql_cmd -Atqc "
      SELECT pg_catalog.count(*) = 1
      FROM pg_catalog.pg_locks
      WHERE locktype = 'advisory'
        AND objid = $lock_key
        AND granted
    ")"
    if [[ "$visible" == 't' ]]; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

concurrent_seal_holder() {
  psql_cmd -Atq <<'SQL'
BEGIN;
SELECT arena.seal_leaderboard_score_input_manifest_v1(
  fixture.payload->>'period',
  fixture.payload->>'sourceBundleDigest',
  fixture.payload->>'scoreRowsDigest',
  fixture.payload->>'physicalBoardsDigest',
  fixture.payload->'sourceEvidence',
  fixture.payload->>'enrichmentContract',
  fixture.payload->'enrichmentEvidence',
  fixture.payload->>'eligibilityContract',
  fixture.payload->'eligibilityEvidence',
  fixture.payload->'inputs',
  fixture.concurrency_valid_until
)->>'manifestId'
FROM public.manifest_fixture AS fixture;
SELECT pg_catalog.pg_advisory_lock(734002001);
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
}

concurrent_seal_holder >"$TMP_ROOT/concurrent-a.txt" &
concurrent_a_pid=$!
if ! wait_for_advisory_lock 734002001; then
  wait "$concurrent_a_pid" || true
  echo "concurrent seal holder did not reach its uncommitted barrier" >&2
  exit 1
fi
concurrent_seal >"$TMP_ROOT/concurrent-b.txt" &
concurrent_b_pid=$!
wait "$concurrent_a_pid"
wait "$concurrent_b_pid"
concurrent_a_id="$(sed -nE '/^[0-9a-f-]{36}$/p' "$TMP_ROOT/concurrent-a.txt" | head -1)"
concurrent_b_id="$(sed -nE '/^[0-9a-f-]{36}$/p' "$TMP_ROOT/concurrent-b.txt" | head -1)"
if [[ -z "$concurrent_a_id" || "$concurrent_a_id" != "$concurrent_b_id" ]]; then
  echo "concurrent equivalent seals returned different manifest ids" >&2
  exit 1
fi
concurrent_row_count="$(psql_cmd -Atqc "
  SELECT pg_catalog.count(*)::text || ':'
    || pg_catalog.count(DISTINCT stored.manifest_digest)::text
  FROM arena.leaderboard_score_input_manifests AS stored
  WHERE stored.valid_until = (
    SELECT fixture.concurrency_valid_until
    FROM public.manifest_fixture AS fixture
  )
")"
if [[ "$concurrent_row_count" != '1:1' ]]; then
  echo "concurrent equivalent seals did not converge to one row: $concurrent_row_count" >&2
  exit 1
fi

# Force a second seal to wait on an uncommitted equivalent content row until
# after its deadline. This reaches the function before the wait, so deleting
# the final post-conflict clock check makes the call return an expired manifest.
psql_cmd -Atq <<'SQL'
UPDATE public.manifest_fixture
SET payload = pg_catalog.jsonb_set(
      payload,
      '{enrichmentEvidence,expiryBarrier}',
      'true'::jsonb
    ),
    concurrency_valid_until = pg_catalog.clock_timestamp() + interval '2.5 seconds';
SQL
psql_cmd -Atq >"$TMP_ROOT/expiry-conflict-holder.txt" <<'SQL' &
BEGIN;
SELECT arena.seal_leaderboard_score_input_manifest_v1(
  fixture.payload->>'period',
  fixture.payload->>'sourceBundleDigest',
  fixture.payload->>'scoreRowsDigest',
  fixture.payload->>'physicalBoardsDigest',
  fixture.payload->'sourceEvidence',
  fixture.payload->>'enrichmentContract',
  fixture.payload->'enrichmentEvidence',
  fixture.payload->>'eligibilityContract',
  fixture.payload->'eligibilityEvidence',
  fixture.payload->'inputs',
  fixture.concurrency_valid_until
)->>'manifestId'
FROM public.manifest_fixture AS fixture;
SELECT pg_catalog.pg_advisory_lock(734002002);
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
expiry_conflict_pid=$!
if ! wait_for_advisory_lock 734002002; then
  wait "$expiry_conflict_pid" || true
  echo "expiry conflict holder did not reach its barrier" >&2
  exit 1
fi
set +e
postwork_expiry_output="$(concurrent_seal 2>&1)"
postwork_expiry_status=$?
set -e
wait "$expiry_conflict_pid"
if ((postwork_expiry_status == 0)); then
  echo "manifest crossed its deadline and still returned successfully" >&2
  exit 1
fi
if [[ "$postwork_expiry_output" != *"validity fell below 1 second"* ]]; then
  echo "post-work expiry failed for the wrong reason" >&2
  echo "$postwork_expiry_output" >&2
  exit 1
fi

set +e
reapply_output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"
reapply_status=$?
set -e
if ((reapply_status == 0)); then
  echo "manifest migration unexpectedly reapplied" >&2
  exit 1
fi
if [[ "$reapply_output" != *"manifest contract already exists; audit before install"* ]]; then
  echo "manifest migration reapply failed for the wrong reason" >&2
  echo "$reapply_output" >&2
  exit 1
fi

echo "leaderboard score-input manifest PostgreSQL 17 proof passed"
