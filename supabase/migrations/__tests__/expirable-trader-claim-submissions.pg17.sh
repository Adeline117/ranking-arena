#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for expirable, retriable trader claims. It
# owns an isolated temporary cluster and never connects to a developer or
# remote application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716113000_expirable_trader_claim_submissions.sql"
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

TMP_ROOT="$(mktemp -d /tmp/expirable-trader-claims-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((55000 + ($$ % 9000)))}"
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

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');

CREATE TABLE public.trader_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  handle text,
  verification_method text NOT NULL CHECK (
    verification_method IN ('api_key', 'signature', 'video', 'social')
  ),
  verification_data jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'reviewing', 'verified', 'rejected')
  ),
  reject_reason text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now(),
  CONSTRAINT trader_claims_trader_id_source_key
    UNIQUE (trader_id, source)
);

CREATE TABLE public.activation_projection (
  claim_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON TABLE public.trader_claims TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trader_claims TO service_role;

INSERT INTO public.trader_claims (
  id,
  user_id,
  trader_id,
  source,
  verification_method,
  verification_data,
  status,
  reject_reason,
  reviewed_by,
  reviewed_at,
  created_at,
  updated_at
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '11111111-1111-4111-8111-111111111111',
    'stale-pending',
    'binance',
    'api_key',
    '{"proof":"pending-history"}',
    'pending',
    NULL,
    NULL,
    NULL,
    pg_catalog.now() - interval '31 days',
    pg_catalog.now() - interval '31 days'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    '11111111-1111-4111-8111-111111111111',
    'stale-reviewing',
    'bybit',
    'api_key',
    '{"proof":"review-history"}',
    'reviewing',
    'historical-note',
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.now() - interval '35 days',
    pg_catalog.now() - interval '40 days',
    pg_catalog.now() - interval '35 days'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    '11111111-1111-4111-8111-111111111111',
    'recent-pending',
    'okx',
    'api_key',
    '{"proof":"recent"}',
    'pending',
    NULL,
    NULL,
    NULL,
    pg_catalog.now() - interval '29 days',
    pg_catalog.now() - interval '29 days'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    '11111111-1111-4111-8111-111111111111',
    'rejected-retry',
    'gate',
    'api_key',
    '{"proof":"rejected-history"}',
    'rejected',
    'proof mismatch',
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() - interval '2 days',
    pg_catalog.now() - interval '1 day'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    '11111111-1111-4111-8111-111111111111',
    'verified-owner',
    'binance',
    'api_key',
    '{"proof":"verified"}',
    'verified',
    NULL,
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() - interval '90 days',
    pg_catalog.now() - interval '1 day'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
    '11111111-1111-4111-8111-111111111111',
    'null-created-at',
    'bitget',
    'api_key',
    '{"proof":"null-clock"}',
    'reviewing',
    NULL,
    NULL,
    NULL,
    NULL,
    pg_catalog.now()
  );
SQL

# Missing activation is a hard preflight failure and must roll back before any
# status, constraint, function, or index mutation.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/preflight.log" 2>&1; then
  echo "claim expiry migration unexpectedly passed without atomic activation" >&2
  exit 1
fi
if ! grep -q \
  'atomic trader-claim activation must exist before adding expirable submissions' \
  "$TMP_ROOT/preflight.log"; then
  cat "$TMP_ROOT/preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $preflight_rollback_proof$
BEGIN
  IF (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
     ) <> 'pending'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.trader_claims'::regclass
         AND conname = 'trader_claims_trader_id_source_key'
     )
     OR pg_catalog.to_regprocedure(
          'public.submit_trader_claim(uuid,text,text,text,jsonb)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'preflight failure did not roll back cleanly';
  END IF;
END
$preflight_rollback_proof$;

-- Minimal stand-in for the already-deployed atomic activation RPC. It writes a
-- projection before exposing verified status, matching the production order;
-- the new guard must roll both writes back for a stale claim.
CREATE FUNCTION public.activate_trader_claim(
  p_claim_id uuid,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  SELECT claim.*
  INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'claim not found';
  END IF;
  IF v_claim.status NOT IN ('pending', 'reviewing', 'verified') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'claim not reviewable';
  END IF;

  INSERT INTO public.activation_projection(claim_id)
  VALUES (v_claim.id)
  ON CONFLICT (claim_id) DO NOTHING;

  UPDATE public.trader_claims AS claim
  SET status = 'verified',
      reviewed_by = COALESCE(claim.reviewed_by, p_reviewer_id),
      reviewed_at = COALESCE(claim.reviewed_at, pg_catalog.now()),
      verified_at = COALESCE(claim.verified_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
  WHERE claim.id = v_claim.id
  RETURNING claim.* INTO STRICT v_claim;

  RETURN pg_catalog.jsonb_build_object('claim', pg_catalog.to_jsonb(v_claim));
END
$function$;
SQL

# Two applications prove the schema rewrite, policy ACLs, functions, and
# trigger converge without deleting terminal history.
psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $migration_proof$
DECLARE
  v_predicate text;
BEGIN
  IF (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
     ) <> 'expired'
     OR (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
     ) <> 'expired'
     OR (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
     ) <> 'pending'
     OR (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
     ) <> 'rejected'
     OR (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'
     ) <> 'verified' THEN
    RAISE EXCEPTION 'stale backfill changed the wrong lifecycle rows';
  END IF;

  IF (
       SELECT verification_data
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
     ) <> '{"proof":"review-history"}'::jsonb
     OR (
       SELECT reject_reason
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
     ) <> 'historical-note'
     OR (
       SELECT reviewed_by
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
     ) <> '22222222-2222-4222-8222-222222222222'::uuid THEN
    RAISE EXCEPTION 'stale backfill destroyed claim audit history';
  END IF;

  IF (
       SELECT created_at IS NULL
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6'
     )
     OR NOT (
       SELECT attnotnull
       FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.trader_claims'::regclass
         AND attname = 'created_at'
     ) THEN
    RAISE EXCEPTION 'created_at expiry clock was not repaired and hardened';
  END IF;

  SELECT pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
  INTO v_predicate
  FROM pg_catalog.pg_index AS index_row
  WHERE index_row.indexrelid =
    'public.trader_claims_one_active_identity_uidx'::regclass;

  IF v_predicate <> '(status = ANY (ARRAY[''pending''::text, ''reviewing''::text, ''verified''::text]))'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.trader_claims'::regclass
         AND conname = 'trader_claims_trader_id_source_key'
     ) THEN
    RAISE EXCEPTION 'active-only identity uniqueness did not replace the full key';
  END IF;
END
$migration_proof$;

-- Terminal rows for one identity are append-only history and may coexist.
INSERT INTO public.trader_claims (
  user_id, trader_id, source, verification_method, verification_data, status
) VALUES
  (
    '22222222-2222-4222-8222-222222222222',
    'stale-pending',
    'binance',
    'api_key',
    '{"proof":"second-terminal"}',
    'rejected'
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'stale-pending',
    'binance',
    'api_key',
    '{"proof":"third-terminal"}',
    'expired'
  );

-- A stale identity gets a distinct reviewing attempt; the old ID and proof
-- remain attached to the old owner.
SET ROLE service_role;
SELECT (public.submit_trader_claim(
  '33333333-3333-4333-8333-333333333333',
  ' stale-pending ',
  ' BINANCE ',
  'api_key',
  '{"uid_hash":"new-proof"}'::jsonb
)).id;
RESET ROLE;

DO $retry_proof$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM public.trader_claims
       WHERE trader_id = 'stale-pending'
         AND source = 'binance'
         AND status = 'reviewing'
     ) <> 1
     OR (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
     ) <> 'expired'
     OR (
       SELECT verification_data
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
     ) <> '{"proof":"pending-history"}'::jsonb
     OR (
       SELECT user_id
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
     ) <> '11111111-1111-4111-8111-111111111111'::uuid THEN
    RAISE EXCEPTION 'stale retry reused or corrupted the historical row';
  END IF;
END
$retry_proof$;

-- Rejected attempts are immediately retriable with a fresh row.
SET ROLE service_role;
SELECT (public.submit_trader_claim(
  '33333333-3333-4333-8333-333333333333',
  'rejected-retry',
  'gate',
  'api_key',
  '{"uid_hash":"retry-proof"}'::jsonb
)).id;
RESET ROLE;

-- The RPC owns the final chain-specific database identity rule: EVM checksum
-- case collapses to lowercase, while Solana Base58 case remains exact.
SET ROLE service_role;
SELECT (public.submit_trader_claim(
  '33333333-3333-4333-8333-333333333333',
  '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01',
  'HYPERLIQUID',
  'signature',
  '{"wallet_address":"0xAbCdEf0123456789aBCdEf0123456789AbCdEf01"}'::jsonb
)).id;
SELECT (public.submit_trader_claim(
  '33333333-3333-4333-8333-333333333333',
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  'drift',
  'signature',
  '{"wallet_address":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"}'::jsonb
)).id;
RESET ROLE;

DO $wallet_identity_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE trader_id = '0xabcdef0123456789abcdef0123456789abcdef01'
         AND source = 'hyperliquid'
         AND status = 'reviewing'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE trader_id = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
         AND source = 'drift'
         AND status = 'reviewing'
     ) THEN
    RAISE EXCEPTION 'chain-specific wallet identity canonicalization is incorrect';
  END IF;

  BEGIN
    PERFORM public.submit_trader_claim(
      '44444444-4444-4444-8444-444444444444',
      '0xabcdef0123456789abcdef0123456789abcdef01',
      'hyperliquid',
      'signature',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'EVM checksum case bypassed active identity uniqueness';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.submit_trader_claim(
      '44444444-4444-4444-8444-444444444444',
      'wallet-id',
      'binance',
      'signature',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'unknown wallet claim source was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$wallet_identity_proof$;

-- Recent and verified identities remain hard conflicts. The index, not an
-- application pre-check, is the race-safe authority.
DO $active_conflict_proof$
BEGIN
  BEGIN
    PERFORM public.submit_trader_claim(
      '33333333-3333-4333-8333-333333333333',
      'recent-pending',
      'okx',
      'api_key',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'recent active claim unexpectedly allowed a retry';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.submit_trader_claim(
      '33333333-3333-4333-8333-333333333333',
      'verified-owner',
      'binance',
      'api_key',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'verified claim unexpectedly allowed a retry';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  IF (
       SELECT pg_catalog.count(*)
       FROM public.trader_claims
       WHERE trader_id IN ('recent-pending', 'verified-owner')
     ) <> 2 THEN
    RAISE EXCEPTION 'conflicting submit left a partial row';
  END IF;
END
$active_conflict_proof$;

-- A downstream insert failure rolls the stale-expiry UPDATE back with it.
INSERT INTO public.trader_claims (
  user_id,
  trader_id,
  source,
  verification_method,
  verification_data,
  status,
  created_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'rollback-me',
  'binance',
  'api_key',
  '{"proof":"must-survive"}',
  'reviewing',
  pg_catalog.now() - interval '31 days'
);

CREATE FUNCTION public.force_claim_insert_failure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.trader_id = 'rollback-me' THEN
    RAISE EXCEPTION 'forced claim insert failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER force_claim_insert_failure
  BEFORE INSERT ON public.trader_claims
  FOR EACH ROW EXECUTE FUNCTION public.force_claim_insert_failure();

DO $atomic_rollback_proof$
BEGIN
  BEGIN
    PERFORM public.submit_trader_claim(
      '22222222-2222-4222-8222-222222222222',
      'rollback-me',
      'binance',
      'api_key',
      '{"uid_hash":"will-fail"}'::jsonb
    );
    RAISE EXCEPTION 'forced submit unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'forced claim insert failure' THEN
        RAISE;
      END IF;
  END;

  IF (
       SELECT status
       FROM public.trader_claims
       WHERE trader_id = 'rollback-me' AND source = 'binance'
     ) <> 'reviewing'
     OR (
       SELECT verification_data
       FROM public.trader_claims
       WHERE trader_id = 'rollback-me' AND source = 'binance'
     ) <> '{"proof":"must-survive"}'::jsonb THEN
    RAISE EXCEPTION 'failed submit did not roll stale expiry back';
  END IF;
END
$atomic_rollback_proof$;

DROP TRIGGER force_claim_insert_failure ON public.trader_claims;
DROP FUNCTION public.force_claim_insert_failure();

-- The activation guard fires after the stand-in RPC wrote its projection. Its
-- exception must roll back both that projection and the final status update.
INSERT INTO public.trader_claims (
  id,
  user_id,
  trader_id,
  source,
  verification_method,
  verification_data,
  status,
  created_at
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  '11111111-1111-4111-8111-111111111111',
  'stale-approval',
  'bybit',
  'api_key',
  '{"proof":"stale-approval"}',
  'reviewing',
  pg_catalog.now() - interval '31 days'
);

DO $stale_approval_proof$
BEGIN
  BEGIN
    PERFORM public.activate_trader_claim(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      '22222222-2222-4222-8222-222222222222'
    );
    RAISE EXCEPTION 'stale claim activation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    NULL;
  END;

  IF (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
     ) <> 'reviewing'
     OR EXISTS (
       SELECT 1
       FROM public.activation_projection
       WHERE claim_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
     ) THEN
    RAISE EXCEPTION 'stale activation leaked a committed projection';
  END IF;

  BEGIN
    UPDATE public.trader_claims
    SET status = 'verified'
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    RAISE EXCEPTION 'expired claim was directly reactivated';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    NULL;
  END;
END
$stale_approval_proof$;

-- A recent claim still activates normally.
SELECT public.activate_trader_claim(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  '22222222-2222-4222-8222-222222222222'
);

DO $recent_activation_proof$
BEGIN
  IF (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
     ) <> 'verified'
     OR NOT EXISTS (
       SELECT 1
       FROM public.activation_projection
       WHERE claim_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
     ) THEN
    RAISE EXCEPTION 'recent activation was incorrectly blocked';
  END IF;
END
$recent_activation_proof$;

-- Simulate later privilege/trigger drift. A third replay must converge it and
-- may lazily expire the intentionally stale test rows without deleting them.
GRANT EXECUTE ON FUNCTION public.submit_trader_claim(
  uuid, text, text, text, jsonb
) TO authenticated;
ALTER TABLE public.trader_claims
  DISABLE TRIGGER trader_claim_activation_expiry_guard;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $replay_convergence_proof$
BEGIN
  IF pg_catalog.has_function_privilege(
       'authenticated',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.trader_claims'::regclass
         AND tgname = 'trader_claim_activation_expiry_guard'
         AND tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION 'idempotent replay did not converge ACL/trigger drift';
  END IF;

  IF (
       SELECT status
       FROM public.trader_claims
       WHERE trader_id = 'rollback-me' AND source = 'binance'
     ) <> 'expired'
     OR (
       SELECT status
       FROM public.trader_claims
       WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
     ) <> 'expired' THEN
    RAISE EXCEPTION 'replay did not converge newly stale active rows';
  END IF;
END
$replay_convergence_proof$;

INSERT INTO public.trader_claims (
  user_id, trader_id, source, verification_method, verification_data, status
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'concurrent-retry',
  'binance',
  'api_key',
  '{"proof":"terminal"}',
  'rejected'
);
SQL

# Two independent service sessions race to create the same active identity.
# The partial unique index must commit exactly one reviewing attempt.
set +e
psql_cmd -c "SET ROLE service_role; SELECT (public.submit_trader_claim('33333333-3333-4333-8333-333333333333','concurrent-retry','binance','api_key','{\"uid_hash\":\"race-a\"}'::jsonb)).id;" \
  >"$TMP_ROOT/race-a.log" 2>&1 &
race_a_pid=$!
psql_cmd -c "SET ROLE service_role; SELECT (public.submit_trader_claim('44444444-4444-4444-8444-444444444444','concurrent-retry','binance','api_key','{\"uid_hash\":\"race-b\"}'::jsonb)).id;" \
  >"$TMP_ROOT/race-b.log" 2>&1 &
race_b_pid=$!
wait "$race_a_pid"
race_a_status=$?
wait "$race_b_pid"
race_b_status=$?
set -e

if ! { [[ $race_a_status -eq 0 && $race_b_status -ne 0 ]] || \
       [[ $race_a_status -ne 0 && $race_b_status -eq 0 ]]; }; then
  echo "concurrent submit did not produce exactly one winner" >&2
  cat "$TMP_ROOT/race-a.log" >&2
  cat "$TMP_ROOT/race-b.log" >&2
  exit 1
fi
if [[ $race_a_status -ne 0 ]]; then
  grep -q 'duplicate key value violates unique constraint' "$TMP_ROOT/race-a.log"
else
  grep -q 'duplicate key value violates unique constraint' "$TMP_ROOT/race-b.log"
fi

psql_cmd <<'SQL'
DO $final_contract$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM public.trader_claims
       WHERE trader_id = 'concurrent-retry'
         AND source = 'binance'
         AND status = 'reviewing'
     ) <> 1
     OR (
       SELECT pg_catalog.count(*)
       FROM public.trader_claims
       WHERE trader_id = 'concurrent-retry'
         AND source = 'binance'
         AND status = 'rejected'
     ) <> 1 THEN
    RAISE EXCEPTION 'concurrent retry history or active winner is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'final submit RPC privilege boundary is incorrect';
  END IF;
END
$final_contract$;
SQL

echo "expirable trader-claim submissions PG17 integration proof passed"
