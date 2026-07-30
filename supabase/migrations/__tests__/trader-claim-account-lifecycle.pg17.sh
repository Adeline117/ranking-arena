#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729160000_trader_claim_account_lifecycle.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/postgres --version)" != postgres\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/trader-claim-lifecycle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT="${PGPORT_OVERRIDE:-$((56000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)); then
    for diagnostic in "$LOG_DIR"/*.log; do
      if [[ -f "$diagnostic" ]]; then
        echo "--- ${diagnostic##*/} ---" >&2
        tail -180 "$diagnostic" >&2 || true
      fi
    done
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

REVIEWER_ID="10000000-0000-4000-8000-000000000001"
ACTIVE_ID="20000000-0000-4000-8000-000000000002"
DELETED_ID="30000000-0000-4000-8000-000000000003"
BANNED_ID="40000000-0000-4000-8000-000000000004"
LEGACY_ID="50000000-0000-4000-8000-000000000005"
EXPIRED_LEGACY_ID="60000000-0000-4000-8000-000000000006"
INACTIVE_REVIEWER_ID="70000000-0000-4000-8000-000000000007"
SUBMIT_DELETE_ID="80000000-0000-4000-8000-000000000008"
ACTIVATE_BAN_ID="90000000-0000-4000-8000-000000000009"
ACTIVATE_DELETE_ID="a0000000-0000-4000-8000-00000000000a"
ACTIVATE_UNLINK_ID="b0000000-0000-4000-8000-00000000000b"

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN;
CREATE EXTENSION pgcrypto;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
ALTER TABLE auth.users OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  is_verified_trader boolean NOT NULL DEFAULT false,
  verified_trader_id text,
  verified_trader_source text,
  linked_trader_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE public.trader_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  verification_method text NOT NULL,
  verification_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'reviewing' CHECK (
    status IN ('pending', 'reviewing', 'verified', 'rejected', 'expired', 'revoked')
  ),
  reject_reason text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE UNIQUE INDEX trader_claims_one_active_identity_uidx
  ON public.trader_claims (trader_id, source)
  WHERE status IN ('pending', 'reviewing', 'verified');

CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  verification_method text NOT NULL,
  is_primary boolean NOT NULL DEFAULT true,
  verified_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (trader_id, source)
);

CREATE TABLE public.user_linked_traders (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  verification_method text NOT NULL,
  is_primary boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  verified_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (trader_id, source)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.trader_claims OWNER TO postgres;
ALTER TABLE public.verified_traders OWNER TO postgres;
ALTER TABLE public.user_linked_traders OWNER TO postgres;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role, authenticator;

-- Production-shaped stand-ins isolate this migration's responsibility. The
-- historical migrations independently prove canonicalization, expiry, full
-- projection reconciliation, and rollback behavior.
CREATE FUNCTION public.submit_trader_claim(
  p_user_id uuid,
  p_trader_id text,
  p_source text,
  p_verification_method text,
  p_verification_data jsonb
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  INSERT INTO public.trader_claims (
    user_id,
    trader_id,
    source,
    verification_method,
    verification_data,
    status
  ) VALUES (
    p_user_id,
    pg_catalog.btrim(p_trader_id),
    pg_catalog.lower(pg_catalog.btrim(p_source)),
    p_verification_method,
    COALESCE(p_verification_data, '{}'::jsonb),
    'reviewing'
  )
  RETURNING * INTO STRICT v_claim;
  RETURN v_claim;
END
$function$;

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
  v_verified_id uuid;
  v_link_id uuid;
  v_linked_count integer;
BEGIN
  SELECT claim.*
  INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.id = p_claim_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'trader claim not found';
  END IF;
  IF v_claim.status NOT IN ('pending', 'reviewing', 'verified') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'claim not reviewable';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || v_claim.user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-claim:' || v_claim.source || ':' || v_claim.trader_id,
      0
    )
  );

  IF v_claim.source = 'concurrency' THEN
    PERFORM pg_catalog.pg_sleep(1.5);
  END IF;

  INSERT INTO public.verified_traders AS existing (
    user_id, trader_id, source, verification_method, is_primary
  ) VALUES (
    v_claim.user_id, v_claim.trader_id, v_claim.source,
    v_claim.verification_method, true
  )
  ON CONFLICT (trader_id, source) DO UPDATE
  SET verification_method = EXCLUDED.verification_method,
      updated_at = pg_catalog.statement_timestamp()
  RETURNING existing.id INTO v_verified_id;

  INSERT INTO public.user_linked_traders AS existing (
    user_id, trader_id, source, verification_method, is_primary
  ) VALUES (
    v_claim.user_id, v_claim.trader_id, v_claim.source,
    v_claim.verification_method, true
  )
  ON CONFLICT (trader_id, source) DO UPDATE
  SET verification_method = EXCLUDED.verification_method,
      updated_at = pg_catalog.statement_timestamp()
  RETURNING existing.id INTO v_link_id;

  SELECT pg_catalog.count(*)::integer
  INTO v_linked_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = v_claim.user_id;

  UPDATE public.user_profiles AS profile
  SET is_verified_trader = true,
      verified_trader_id = v_claim.trader_id,
      verified_trader_source = v_claim.source,
      linked_trader_count = v_linked_count,
      updated_at = pg_catalog.statement_timestamp()
  WHERE profile.id = v_claim.user_id;

  UPDATE public.trader_claims AS claim
  SET status = 'verified',
      reviewed_by = COALESCE(claim.reviewed_by, p_reviewer_id),
      reviewed_at = COALESCE(claim.reviewed_at, pg_catalog.statement_timestamp()),
      verified_at = COALESCE(claim.verified_at, pg_catalog.statement_timestamp()),
      updated_at = pg_catalog.statement_timestamp()
  WHERE claim.id = v_claim.id
  RETURNING claim.* INTO STRICT v_claim;

  RETURN pg_catalog.jsonb_build_object(
    'claim', pg_catalog.to_jsonb(v_claim),
    'linked_trader_id', v_link_id,
    'primary_link_id', v_link_id,
    'linked_count', v_linked_count,
    'authorization_id', NULL,
    'arena_trader_id', 101
  );
END
$function$;

CREATE FUNCTION public.unlink_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS TABLE (
  remaining_count integer,
  removed_trader_id text,
  removed_source text,
  promoted_link_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_link public.user_linked_traders%ROWTYPE;
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  SELECT linked.*
  INTO v_link
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'linked trader not found';
  END IF;

  SELECT claim.*
  INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.user_id = p_user_id
    AND claim.trader_id = v_link.trader_id
    AND claim.source = v_link.source
    AND claim.status = 'verified'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'verified claim not found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-claim:' || v_link.source || ':' || v_link.trader_id,
      0
    )
  );

  DELETE FROM public.user_linked_traders WHERE id = v_link.id;
  DELETE FROM public.verified_traders
  WHERE user_id = p_user_id
    AND trader_id = v_link.trader_id
    AND source = v_link.source;
  UPDATE public.trader_claims SET status = 'revoked' WHERE id = v_claim.id;
  UPDATE public.user_profiles
  SET is_verified_trader = false,
      verified_trader_id = NULL,
      verified_trader_source = NULL,
      linked_trader_count = 0,
      updated_at = pg_catalog.statement_timestamp()
  WHERE id = p_user_id;

  RETURN QUERY SELECT 0, v_link.trader_id, v_link.source, NULL::uuid;
END
$function$;

ALTER FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb)
  OWNER TO postgres;
ALTER FUNCTION public.activate_trader_claim(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.unlink_linked_trader(uuid, uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_trader_claim(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd \
  -v reviewer="$REVIEWER_ID" \
  -v active="$ACTIVE_ID" \
  -v deleted="$DELETED_ID" \
  -v banned="$BANNED_ID" \
  -v legacy="$LEGACY_ID" \
  -v expired_legacy="$EXPIRED_LEGACY_ID" \
  -v inactive_reviewer="$INACTIVE_REVIEWER_ID" \
  -v submit_delete="$SUBMIT_DELETE_ID" \
  -v activate_ban="$ACTIVATE_BAN_ID" \
  -v activate_delete="$ACTIVATE_DELETE_ID" \
  -v activate_unlink="$ACTIVATE_UNLINK_ID" <<'SQL'
SET ROLE postgres;

INSERT INTO auth.users(id) VALUES
  (:'reviewer'),
  (:'active'),
  (:'deleted'),
  (:'banned'),
  (:'legacy'),
  (:'expired_legacy'),
  (:'inactive_reviewer'),
  (:'submit_delete'),
  (:'activate_ban'),
  (:'activate_delete'),
  (:'activate_unlink');

INSERT INTO public.user_profiles (
  id, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  (:'reviewer', NULL, NULL, false, NULL),
  (:'active', NULL, NULL, false, NULL),
  (:'deleted', pg_catalog.now(), NULL, false, NULL),
  (:'banned', NULL, pg_catalog.now(), false, NULL),
  (:'legacy', NULL, NULL, true, NULL),
  (:'expired_legacy', NULL, NULL, true, pg_catalog.now() - interval '1 hour'),
  (:'inactive_reviewer', pg_catalog.now(), NULL, false, NULL),
  (:'submit_delete', NULL, NULL, false, NULL),
  (:'activate_ban', NULL, NULL, false, NULL),
  (:'activate_delete', NULL, NULL, false, NULL),
  (:'activate_unlink', NULL, NULL, false, NULL);

DO $metadata$
DECLARE
  v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.submit_trader_claim(uuid,text,text,text,jsonb)'::regprocedure,
    'public.activate_trader_claim(uuid,uuid)'::regprocedure,
    'public.unlink_linked_trader(uuid,uuid)'::regprocedure
  ]
  LOOP
    IF NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticator', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'public trader-claim ACL drifted: %', v_function;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.activate_trader_claim_without_account_lifecycle_internal(uuid,uuid)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'service_role',
       'public.unlink_linked_trader_without_account_lifecycle_internal(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'internal projection implementation remained executable';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  BEGIN
    PERFORM public.submit_trader_claim(
      '20000000-0000-4000-8000-000000000002',
      'runtime-guard',
      'hyperliquid',
      'signature',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'runtime service-role guard was bypassed';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$metadata$;
SQL

# Deleted, modern-banned, and active legacy-banned claimants cannot submit.
psql_cmd \
  -v deleted="$DELETED_ID" \
  -v banned="$BANNED_ID" \
  -v legacy="$LEGACY_ID" \
  -v expired_legacy="$EXPIRED_LEGACY_ID" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $inactive_submit_proof$
DECLARE
  v_user_id uuid;
  v_rejected boolean;
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  FOREACH v_user_id IN ARRAY ARRAY[
    '30000000-0000-4000-8000-000000000003'::uuid,
    '40000000-0000-4000-8000-000000000004'::uuid,
    '50000000-0000-4000-8000-000000000005'::uuid
  ]
  LOOP
    v_rejected := false;
    BEGIN
      PERFORM public.submit_trader_claim(
        v_user_id,
        'forbidden-' || v_user_id::text,
        'hyperliquid',
        'signature',
        '{}'::jsonb
      );
    EXCEPTION
      WHEN invalid_parameter_value THEN
        v_rejected := SQLERRM = 'inactive trader claim principal';
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'inactive claimant submission was not rejected: %', v_user_id;
    END IF;
  END LOOP;

  SELECT * INTO v_claim
  FROM public.submit_trader_claim(
    '60000000-0000-4000-8000-000000000006',
    'expired-legacy-allowed',
    'hyperliquid',
    'signature',
    '{"proof":"still-active-account"}'::jsonb
  );
  IF v_claim.user_id IS DISTINCT FROM
       '60000000-0000-4000-8000-000000000006'::uuid
     OR v_claim.status IS DISTINCT FROM 'reviewing' THEN
    RAISE EXCEPTION 'expired legacy sanction was treated as active';
  END IF;
END
$inactive_submit_proof$;
RESET ROLE;

DO $no_forbidden_claims$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.trader_claims
    WHERE trader_id LIKE 'forbidden-%'
  ) THEN
    RAISE EXCEPTION 'rejected inactive submission wrote a claim';
  END IF;
END
$no_forbidden_claims$;
SQL

# Active submission and activation retain the established row/JSON contracts
# and create all ownership projections.
psql_cmd -v reviewer="$REVIEWER_ID" -v active="$ACTIVE_ID" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $active_regression$
DECLARE
  v_claim public.trader_claims%ROWTYPE;
  v_result jsonb;
  v_keys text[];
BEGIN
  SELECT * INTO v_claim
  FROM public.submit_trader_claim(
    '20000000-0000-4000-8000-000000000002',
    'active-wallet',
    'hyperliquid',
    'signature',
    '{"proof":"valid"}'::jsonb
  );
  IF v_claim.user_id IS DISTINCT FROM
       '20000000-0000-4000-8000-000000000002'::uuid
     OR v_claim.trader_id IS DISTINCT FROM 'active-wallet'
     OR v_claim.source IS DISTINCT FROM 'hyperliquid'
     OR v_claim.status IS DISTINCT FROM 'reviewing'
     OR v_claim.verification_data IS DISTINCT FROM '{"proof":"valid"}'::jsonb THEN
    RAISE EXCEPTION 'submission row contract changed';
  END IF;

  v_result := public.activate_trader_claim(
    v_claim.id,
    '10000000-0000-4000-8000-000000000001'
  );
  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_keys
  FROM pg_catalog.jsonb_object_keys(v_result) AS keys(key_name);
  IF v_keys IS DISTINCT FROM ARRAY[
       'arena_trader_id',
       'authorization_id',
       'claim',
       'linked_count',
       'linked_trader_id',
       'primary_link_id'
     ]::text[]
     OR v_result->'claim'->>'status' IS DISTINCT FROM 'verified'
     OR (v_result->>'linked_count')::integer <> 1 THEN
    RAISE EXCEPTION 'activation JSON contract changed: %', v_result;
  END IF;
END
$active_regression$;
RESET ROLE;

DO $active_projection_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE user_id = '20000000-0000-4000-8000-000000000002'
         AND trader_id = 'active-wallet'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE user_id = '20000000-0000-4000-8000-000000000002'
         AND trader_id = 'active-wallet'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '20000000-0000-4000-8000-000000000002'
         AND is_verified_trader
         AND verified_trader_id = 'active-wallet'
         AND linked_trader_count = 1
     ) THEN
    RAISE EXCEPTION 'active approval did not preserve ownership projections';
  END IF;
END
$active_projection_proof$;
SQL

# Inactive claimant and reviewer checks occur before any projection write.
psql_cmd \
  -v active="$ACTIVE_ID" \
  -v banned="$BANNED_ID" \
  -v reviewer="$REVIEWER_ID" \
  -v inactive_reviewer="$INACTIVE_REVIEWER_ID" <<'SQL'
INSERT INTO public.trader_claims (
  id, user_id, trader_id, source, verification_method, status
) VALUES
  ('c1000000-0000-4000-8000-000000000001', :'banned', 'banned-approval', 'gmx', 'signature', 'reviewing'),
  ('c2000000-0000-4000-8000-000000000002', :'active', 'inactive-reviewer', 'gains', 'signature', 'reviewing');

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $inactive_activation_proof$
DECLARE
  v_case record;
  v_rejected boolean;
BEGIN
  FOR v_case IN
    SELECT * FROM (
      VALUES
        (
          'c1000000-0000-4000-8000-000000000001'::uuid,
          '10000000-0000-4000-8000-000000000001'::uuid
        ),
        (
          'c2000000-0000-4000-8000-000000000002'::uuid,
          '70000000-0000-4000-8000-000000000007'::uuid
        )
    ) AS cases(claim_id, reviewer_id)
  LOOP
    v_rejected := false;
    BEGIN
      PERFORM public.activate_trader_claim(v_case.claim_id, v_case.reviewer_id);
    EXCEPTION
      WHEN invalid_parameter_value THEN
        v_rejected := SQLERRM = 'inactive trader claim principal';
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'inactive activation principal was not rejected: %', v_case;
    END IF;
  END LOOP;
END
$inactive_activation_proof$;
RESET ROLE;

DO $inactive_projection_proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id IN ('banned-approval', 'inactive-reviewer')
     )
     OR EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE trader_id IN ('banned-approval', 'inactive-reviewer')
     )
     OR EXISTS (
       SELECT 1 FROM public.trader_claims
       WHERE id IN (
         'c1000000-0000-4000-8000-000000000001',
         'c2000000-0000-4000-8000-000000000002'
       )
         AND status <> 'reviewing'
     ) THEN
    RAISE EXCEPTION 'inactive activation left a partial projection';
  END IF;
END
$inactive_projection_proof$;
SQL

# A deletion that wins the canonical lifecycle lock makes a late submission
# wait, re-read the committed tombstone, and fail without a claim row.
psql_cmd -v user_id="$SUBMIT_DELETE_ID" >"$LOG_DIR/submit-delete-writer.log" 2>&1 <<'SQL' &
SET application_name = 'claim-submit-delete-writer';
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('account-recovery-admission:' || :'user_id', 0)
);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = :'user_id';
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
SUBMIT_DELETE_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'claim-submit-delete-writer' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Submit/delete writer did not reach its lifecycle hold" >&2
  exit 1
fi

psql_cmd -v user_id="$SUBMIT_DELETE_ID" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $late_submit$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.submit_trader_claim(
      '80000000-0000-4000-8000-000000000008',
      'late-submit',
      'gmx',
      'signature',
      '{}'::jsonb
    );
  EXCEPTION
    WHEN invalid_parameter_value THEN
      v_rejected := SQLERRM = 'inactive trader claim principal';
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'late concurrent submission was not rejected';
  END IF;
END
$late_submit$;
SQL
wait "$SUBMIT_DELETE_PID"
if [[ "$(psql_cmd -Atc "SELECT count(*) FROM public.trader_claims WHERE trader_id = 'late-submit'")" != "0" ]]; then
  echo "Late concurrent submission wrote a claim" >&2
  exit 1
fi

# A concurrent ban uses the same namespace. Activation waits and rejects the
# newly inactive claimant before creating any ownership projection.
psql_cmd -v user_id="$ACTIVATE_BAN_ID" <<'SQL'
INSERT INTO public.trader_claims (
  id, user_id, trader_id, source, verification_method, status
) VALUES (
  'd1000000-0000-4000-8000-000000000001',
  :'user_id',
  'ban-race',
  'gains',
  'signature',
  'reviewing'
);
SQL

psql_cmd -v user_id="$ACTIVATE_BAN_ID" >"$LOG_DIR/activate-ban-writer.log" 2>&1 <<'SQL' &
SET application_name = 'claim-activate-ban-writer';
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('account-recovery-admission:' || :'user_id', 0)
);
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp()
WHERE id = :'user_id';
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
ACTIVATE_BAN_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'claim-activate-ban-writer' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Activate/ban writer did not reach its lifecycle hold" >&2
  exit 1
fi

psql_cmd -v reviewer="$REVIEWER_ID" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $late_activation$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.activate_trader_claim(
      'd1000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001'
    );
  EXCEPTION
    WHEN invalid_parameter_value THEN
      v_rejected := SQLERRM = 'inactive trader claim principal';
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'activation concurrent with ban was not rejected';
  END IF;
END
$late_activation$;
SQL
wait "$ACTIVATE_BAN_PID"
if [[ "$(psql_cmd -Atc "SELECT count(*) FROM public.verified_traders WHERE trader_id = 'ban-race'")" != "0" ]] \
   || [[ "$(psql_cmd -Atc "SELECT count(*) FROM public.user_linked_traders WHERE trader_id = 'ban-race'")" != "0" ]]; then
  echo "Activation concurrent with ban created a projection" >&2
  exit 1
fi

# A hard deletion may cascade the observed pending claim while activation is
# waiting. The wrapper rechecks Auth/profile/claim after the lifecycle lock and
# fails closed instead of reconstructing ownership.
psql_cmd -v user_id="$ACTIVATE_DELETE_ID" <<'SQL'
INSERT INTO public.trader_claims (
  id, user_id, trader_id, source, verification_method, status
) VALUES (
  'd2000000-0000-4000-8000-000000000002',
  :'user_id',
  'delete-race',
  'gmx',
  'signature',
  'reviewing'
);
SQL

psql_cmd -v user_id="$ACTIVATE_DELETE_ID" >"$LOG_DIR/activate-delete-writer.log" 2>&1 <<'SQL' &
SET application_name = 'claim-activate-delete-writer';
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('account-recovery-admission:' || :'user_id', 0)
);
DELETE FROM auth.users WHERE id = :'user_id';
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
ACTIVATE_DELETE_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'claim-activate-delete-writer' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Activate/delete writer did not reach its lifecycle hold" >&2
  exit 1
fi

psql_cmd -v reviewer="$REVIEWER_ID" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $deleted_activation$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.activate_trader_claim(
      'd2000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001'
    );
  EXCEPTION
    WHEN no_data_found THEN
      v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'activation concurrent with deletion was not rejected';
  END IF;
END
$deleted_activation$;
SQL
wait "$ACTIVATE_DELETE_PID"
if [[ "$(psql_cmd -Atc "SELECT count(*) FROM public.trader_claims WHERE trader_id = 'delete-race'")" != "0" ]] \
   || [[ "$(psql_cmd -Atc "SELECT count(*) FROM public.verified_traders WHERE trader_id = 'delete-race'")" != "0" ]] \
   || [[ "$(psql_cmd -Atc "SELECT count(*) FROM public.user_linked_traders WHERE trader_id = 'delete-race'")" != "0" ]]; then
  echo "Activation concurrent with hard deletion survived its cascade" >&2
  exit 1
fi

# Activation and unlink now share lifecycle -> profile -> claim before the
# unchanged linked-trader -> identity advisory order. Force activation to hold
# every lock while unlink starts; both must finish without a deadlock.
psql_cmd -v user_id="$ACTIVATE_UNLINK_ID" -v reviewer="$REVIEWER_ID" <<'SQL'
INSERT INTO public.trader_claims (
  id, user_id, trader_id, source, verification_method, status
) VALUES (
  'd3000000-0000-4000-8000-000000000003',
  :'user_id',
  'lock-order-race',
  'concurrency',
  'signature',
  'reviewing'
);
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.activate_trader_claim(
  'd3000000-0000-4000-8000-000000000003', :'reviewer'
);
SQL

LINK_ID="$(psql_cmd -Atc "SELECT id FROM public.user_linked_traders WHERE trader_id = 'lock-order-race'")"
psql_cmd -v reviewer="$REVIEWER_ID" >"$LOG_DIR/activate-unlink-activation.log" 2>&1 <<'SQL' &
SET application_name = 'claim-activate-before-unlink';
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.activate_trader_claim(
  'd3000000-0000-4000-8000-000000000003', :'reviewer'
);
SQL
ACTIVATE_UNLINK_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'claim-activate-before-unlink' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Activation/unlink proof did not reach the activation lock hold" >&2
  exit 1
fi

psql_cmd -v user_id="$ACTIVATE_UNLINK_ID" -v link_id="$LINK_ID" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT * FROM public.unlink_linked_trader(:'user_id', :'link_id');
SQL
wait "$ACTIVATE_UNLINK_PID"

psql_cmd <<'SQL'
DO $final_lock_order_proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = 'lock-order-race'
     )
     OR EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE trader_id = 'lock-order-race'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.trader_claims
       WHERE id = 'd3000000-0000-4000-8000-000000000003'
         AND status = 'revoked'
     )
     OR EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = 'b0000000-0000-4000-8000-00000000000b'
         AND (
           is_verified_trader
           OR linked_trader_count <> 0
           OR verified_trader_id IS NOT NULL
         )
     ) THEN
    RAISE EXCEPTION 'activation/unlink serialization left inconsistent state';
  END IF;
END
$final_lock_order_proof$;
SQL

echo "trader-claim account lifecycle PostgreSQL 17 proof passed"
