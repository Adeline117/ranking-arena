#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PRIMARY_PROJECTION_MIGRATION="$ROOT_DIR/supabase/migrations/20260729071000_atomic_primary_trader_projection.sql"
CLAIM_LIFECYCLE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729160000_trader_claim_account_lifecycle.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729162500_primary_trader_account_lifecycle.sql"
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

TMP_ROOT="$(mktemp -d /tmp/primary-trader-lifecycle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 2000)))}"
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

CREATE TABLE auth.users (id uuid PRIMARY KEY);
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

CREATE TABLE public.user_linked_traders (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  verified_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  verification_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, trader_id, source),
  UNIQUE (trader_id, source)
);
CREATE UNIQUE INDEX user_linked_traders_one_primary_per_user
  ON public.user_linked_traders (user_id)
  WHERE is_primary IS TRUE;

CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  verification_method text NOT NULL DEFAULT 'signature',
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (trader_id, source)
);

CREATE TABLE public.trader_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  verification_method text NOT NULL DEFAULT 'signature',
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

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_linked_traders OWNER TO postgres;
ALTER TABLE public.verified_traders OWNER TO postgres;
ALTER TABLE public.trader_claims OWNER TO postgres;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role, authenticator;

CREATE FUNCTION public.set_primary_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS public.user_linked_traders
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $stub$
  SELECT linked.*
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id AND linked.user_id = p_user_id
$stub$;

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
    user_id, trader_id, source, verification_method, verification_data
  ) VALUES (
    p_user_id, p_trader_id, p_source, p_verification_method,
    COALESCE(p_verification_data, '{}'::jsonb)
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
  v_link public.user_linked_traders%ROWTYPE;
  v_primary public.user_linked_traders%ROWTYPE;
  v_count integer;
BEGIN
  SELECT claim.* INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.id = p_claim_id
  FOR UPDATE;
  IF NOT FOUND OR v_claim.status NOT IN ('pending', 'reviewing', 'verified') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'claim not reviewable';
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
  IF v_claim.source = 'activate-race' THEN
    PERFORM pg_catalog.pg_sleep(1.5);
  END IF;

  INSERT INTO public.verified_traders AS existing (
    user_id, trader_id, source, verification_method, is_primary
  ) VALUES (
    v_claim.user_id, v_claim.trader_id, v_claim.source,
    v_claim.verification_method, false
  )
  ON CONFLICT (trader_id, source) DO UPDATE
  SET updated_at = pg_catalog.statement_timestamp();

  INSERT INTO public.user_linked_traders AS existing (
    user_id, trader_id, source, verification_method, is_primary, display_order
  ) VALUES (
    v_claim.user_id, v_claim.trader_id, v_claim.source,
    v_claim.verification_method, false, 100
  )
  ON CONFLICT (trader_id, source) DO UPDATE
  SET updated_at = pg_catalog.statement_timestamp()
  RETURNING existing.* INTO v_link;

  SELECT linked.* INTO v_primary
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = v_claim.user_id AND linked.is_primary
  ORDER BY linked.display_order, linked.id
  LIMIT 1;
  IF NOT FOUND THEN
    UPDATE public.user_linked_traders
    SET is_primary = true
    WHERE id = v_link.id
    RETURNING * INTO v_primary;
    UPDATE public.verified_traders
    SET is_primary = true
    WHERE user_id = v_claim.user_id
      AND trader_id = v_link.trader_id
      AND source = v_link.source;
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_count
  FROM public.user_linked_traders WHERE user_id = v_claim.user_id;
  UPDATE public.user_profiles
  SET is_verified_trader = true,
      verified_trader_id = v_primary.trader_id,
      verified_trader_source = v_primary.source,
      linked_trader_count = v_count,
      updated_at = pg_catalog.statement_timestamp()
  WHERE id = v_claim.user_id;
  UPDATE public.trader_claims
  SET status = 'verified',
      reviewed_by = p_reviewer_id,
      reviewed_at = COALESCE(reviewed_at, pg_catalog.statement_timestamp()),
      verified_at = COALESCE(verified_at, pg_catalog.statement_timestamp()),
      updated_at = pg_catalog.statement_timestamp()
  WHERE id = v_claim.id;

  RETURN pg_catalog.jsonb_build_object(
    'claim', pg_catalog.to_jsonb(v_claim),
    'linked_trader_id', v_link.id,
    'primary_link_id', v_primary.id,
    'linked_count', v_count,
    'authorization_id', NULL,
    'arena_trader_id', 1
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
  v_primary public.user_linked_traders%ROWTYPE;
  v_count integer;
BEGIN
  SELECT linked.* INTO v_link
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id AND linked.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'link not found';
  END IF;

  SELECT claim.* INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.user_id = p_user_id
    AND claim.trader_id = v_link.trader_id
    AND claim.source = v_link.source
    AND claim.status = 'verified'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'claim not found';
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
  IF v_link.source = 'unlink-race' THEN
    PERFORM pg_catalog.pg_sleep(1.5);
  END IF;

  DELETE FROM public.user_linked_traders WHERE id = v_link.id;
  DELETE FROM public.verified_traders
  WHERE user_id = p_user_id
    AND trader_id = v_link.trader_id
    AND source = v_link.source;
  UPDATE public.trader_claims SET status = 'revoked' WHERE id = v_claim.id;

  SELECT pg_catalog.count(*)::integer INTO v_count
  FROM public.user_linked_traders WHERE user_id = p_user_id;
  SELECT linked.* INTO v_primary
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id
  ORDER BY linked.is_primary DESC, linked.display_order, linked.id
  LIMIT 1;
  IF FOUND THEN
    UPDATE public.user_linked_traders
    SET is_primary = id = v_primary.id
    WHERE user_id = p_user_id;
    UPDATE public.verified_traders
    SET is_primary = trader_id = v_primary.trader_id AND source = v_primary.source
    WHERE user_id = p_user_id;
    UPDATE public.user_profiles
    SET verified_trader_id = v_primary.trader_id,
        verified_trader_source = v_primary.source,
        linked_trader_count = v_count,
        updated_at = pg_catalog.statement_timestamp()
    WHERE id = p_user_id;
  END IF;

  RETURN QUERY SELECT v_count, v_link.trader_id, v_link.source, v_primary.id;
END
$function$;

ALTER FUNCTION public.set_primary_linked_trader(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.activate_trader_claim(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.unlink_linked_trader(uuid, uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.set_primary_linked_trader(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_trader_claim(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader(uuid, uuid) TO service_role;
SQL

psql_cmd -f "$PRIMARY_PROJECTION_MIGRATION" >/dev/null
psql_cmd -f "$CLAIM_LIFECYCLE_MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
-- Pause inside the historical implementation after it owns the linked-trader
-- advisory/rows but before its profile write. Without the new outer lifecycle
-- wrapper this creates the exact reverse edge against activation/unlink.
CREATE FUNCTION public.pause_primary_lifecycle_proof()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.source IN ('primary-activate-trigger', 'primary-unlink-trigger')
     AND NEW.is_primary
     AND NOT OLD.is_primary THEN
    PERFORM pg_catalog.pg_sleep(1.5);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER pause_primary_lifecycle_proof
  BEFORE UPDATE OF is_primary ON public.verified_traders
  FOR EACH ROW
  EXECUTE FUNCTION public.pause_primary_lifecycle_proof();

INSERT INTO auth.users(id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000004'),
  ('50000000-0000-4000-8000-000000000005'),
  ('60000000-0000-4000-8000-000000000006'),
  ('70000000-0000-4000-8000-000000000007'),
  ('80000000-0000-4000-8000-000000000008');

INSERT INTO public.user_profiles (
  id, deleted_at, banned_at, is_banned, ban_expires_at,
  is_verified_trader, linked_trader_count
) VALUES
  ('10000000-0000-4000-8000-000000000001', NULL, NULL, false, NULL, false, 0),
  ('20000000-0000-4000-8000-000000000002', NULL, NULL, false, NULL, true, 2),
  ('30000000-0000-4000-8000-000000000003', pg_catalog.now(), NULL, false, NULL, true, 2),
  ('40000000-0000-4000-8000-000000000004', NULL, pg_catalog.now(), false, NULL, true, 2),
  ('50000000-0000-4000-8000-000000000005', NULL, NULL, false, NULL, true, 2),
  ('60000000-0000-4000-8000-000000000006', NULL, NULL, false, NULL, true, 2),
  ('70000000-0000-4000-8000-000000000007', NULL, NULL, false, NULL, true, 2),
  ('80000000-0000-4000-8000-000000000008', NULL, NULL, false, NULL, true, 2);

INSERT INTO public.user_linked_traders (
  id, user_id, trader_id, source, is_primary, display_order, verification_method
) VALUES
  ('21000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'active-a', 'gmx', true, 0, 'signature'),
  ('21000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'active-b', 'gains', false, 1, 'signature'),
  ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'deleted-a', 'gmx', true, 0, 'signature'),
  ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', 'deleted-b', 'gains', false, 1, 'signature'),
  ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000004', 'banned-a', 'gmx', true, 0, 'signature'),
  ('41000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000004', 'banned-b', 'gains', false, 1, 'signature'),
  ('51000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000005', 'activate-existing', 'gmx', true, 0, 'signature'),
  ('51000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000005', 'activate-primary-target', 'primary-activate-trigger', false, 1, 'signature'),
  ('61000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000006', 'unlink-first', 'unlink-race', true, 0, 'signature'),
  ('61000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000006', 'unlink-remaining', 'primary-unlink-trigger', false, 1, 'signature'),
  ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000007', 'delete-a', 'gmx', true, 0, 'signature'),
  ('71000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000007', 'delete-b', 'gains', false, 1, 'signature'),
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000008', 'ban-a', 'gmx', true, 0, 'signature'),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000008', 'ban-b', 'gains', false, 1, 'signature');

INSERT INTO public.verified_traders (
  user_id, trader_id, source, verification_method, is_primary
)
SELECT user_id, trader_id, source, verification_method, is_primary
FROM public.user_linked_traders;

INSERT INTO public.trader_claims (
  id, user_id, trader_id, source, status, verified_at
) VALUES
  ('91000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000005', 'activate-existing', 'gmx', 'verified', pg_catalog.now()),
  ('91000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000005', 'activate-new', 'activate-race', 'reviewing', NULL),
  ('92000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000006', 'unlink-first', 'unlink-race', 'verified', pg_catalog.now()),
  ('92000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000006', 'unlink-remaining', 'primary-unlink-trigger', 'verified', pg_catalog.now());

UPDATE public.user_profiles AS profile
SET verified_trader_id = linked.trader_id,
    verified_trader_source = linked.source
FROM public.user_linked_traders AS linked
WHERE linked.user_id = profile.id AND linked.is_primary;

DO $metadata$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.set_primary_linked_trader(uuid,uuid)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'public.set_primary_linked_trader(uuid,uuid)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.set_primary_linked_trader_without_account_lifecycle_internal(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'primary lifecycle ACL was not installed';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '20000000-0000-4000-8000-000000000002',
      '21000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'runtime service guard was bypassed';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$metadata$;
SQL

# Active regression preserves the exact composite acknowledgement and all
# canonical primary projections. Deleted and banned users fail before writes.
psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $primary_regression$
DECLARE
  v_result public.user_linked_traders%ROWTYPE;
  v_case record;
  v_rejected boolean;
BEGIN
  v_result := public.set_primary_linked_trader(
    '20000000-0000-4000-8000-000000000002',
    '21000000-0000-4000-8000-000000000002'
  );
  IF v_result.id IS DISTINCT FROM '21000000-0000-4000-8000-000000000002'::uuid
     OR v_result.user_id IS DISTINCT FROM '20000000-0000-4000-8000-000000000002'::uuid
     OR v_result.trader_id IS DISTINCT FROM 'active-b'
     OR v_result.source IS DISTINCT FROM 'gains'
     OR NOT v_result.is_primary THEN
    RAISE EXCEPTION 'primary acknowledgement contract changed';
  END IF;

  FOR v_case IN
    SELECT * FROM (
      VALUES
        (
          '30000000-0000-4000-8000-000000000003'::uuid,
          '31000000-0000-4000-8000-000000000002'::uuid
        ),
        (
          '40000000-0000-4000-8000-000000000004'::uuid,
          '41000000-0000-4000-8000-000000000002'::uuid
        )
    ) AS cases(user_id, link_id)
  LOOP
    v_rejected := false;
    BEGIN
      PERFORM public.set_primary_linked_trader(v_case.user_id, v_case.link_id);
    EXCEPTION
      WHEN invalid_parameter_value THEN
        v_rejected := SQLERRM = 'inactive trader claim principal';
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'inactive primary owner was not rejected: %', v_case.user_id;
    END IF;
  END LOOP;
END
$primary_regression$;
RESET ROLE;

DO $projection_regression$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = '21000000-0000-4000-8000-000000000002' AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = 'active-b' AND source = 'gains' AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '20000000-0000-4000-8000-000000000002'
         AND verified_trader_id = 'active-b'
         AND verified_trader_source = 'gains'
         AND linked_trader_count = 2
     )
     OR EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id IN (
         '31000000-0000-4000-8000-000000000002',
         '41000000-0000-4000-8000-000000000002'
       ) AND is_primary
     ) THEN
    RAISE EXCEPTION 'primary regression projection mismatch';
  END IF;
END
$projection_regression$;
SQL

# Force primary selection to pause after the historical implementation owns
# linked authority and before it writes profile. Activation must wait at the
# outer lifecycle lock; without the wrapper these sessions form the old cycle.
psql_cmd >"$LOG_DIR/primary-activate.log" 2>&1 <<'SQL' &
SET application_name = 'primary-before-activate';
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.set_primary_linked_trader(
  '50000000-0000-4000-8000-000000000005',
  '51000000-0000-4000-8000-000000000002'
);
SQL
PRIMARY_ACTIVATE_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'primary-before-activate' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Primary switch did not reach its activation lock hold" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.activate_trader_claim(
  '91000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001'
);
SQL
wait "$PRIMARY_ACTIVATE_PID"

# Force the same historical pause before revocation. Unlink waits for the outer
# lifecycle lock, then deletes the former primary without a reverse lock edge.
psql_cmd >"$LOG_DIR/primary-unlink.log" 2>&1 <<'SQL' &
SET application_name = 'primary-before-unlink';
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.set_primary_linked_trader(
  '60000000-0000-4000-8000-000000000006',
  '61000000-0000-4000-8000-000000000002'
);
SQL
PRIMARY_UNLINK_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'primary-before-unlink' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Primary switch did not reach its unlink lock hold" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT * FROM public.unlink_linked_trader(
  '60000000-0000-4000-8000-000000000006',
  '61000000-0000-4000-8000-000000000001'
);
SQL
wait "$PRIMARY_UNLINK_PID"

# Delete and ban writers that win lifecycle admission make late primary
# selection re-read committed account state and reject without a projection.
psql_cmd >"$LOG_DIR/primary-delete.log" 2>&1 <<'SQL' &
SET application_name = 'primary-delete-first';
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:70000000-0000-4000-8000-000000000007',
    0
  )
);
DELETE FROM auth.users
WHERE id = '70000000-0000-4000-8000-000000000007';
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
DELETE_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'primary-delete-first' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Delete did not reach its primary-switch lifecycle hold" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $delete_loser$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '70000000-0000-4000-8000-000000000007',
      '71000000-0000-4000-8000-000000000002'
    );
  EXCEPTION
    WHEN no_data_found THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'primary switch concurrent with deletion was not rejected';
  END IF;
END
$delete_loser$;
SQL
wait "$DELETE_PID"

psql_cmd >"$LOG_DIR/primary-ban.log" 2>&1 <<'SQL' &
SET application_name = 'primary-ban-first';
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:80000000-0000-4000-8000-000000000008',
    0
  )
);
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp()
WHERE id = '80000000-0000-4000-8000-000000000008';
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
BAN_PID=$!

for _ in $(seq 1 100); do
  wait_count="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'primary-ban-first' AND wait_event = 'PgSleep'")"
  [[ "$wait_count" == "1" ]] && break
  sleep 0.05
done
if [[ "${wait_count:-0}" != "1" ]]; then
  echo "Ban did not reach its primary-switch lifecycle hold" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $ban_loser$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '80000000-0000-4000-8000-000000000008',
      '81000000-0000-4000-8000-000000000002'
    );
  EXCEPTION
    WHEN invalid_parameter_value THEN
      v_rejected := SQLERRM = 'inactive trader claim principal';
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'primary switch concurrent with ban was not rejected';
  END IF;
END
$ban_loser$;
SQL
wait "$BAN_PID"

psql_cmd <<'SQL'
DO $final_projection_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '50000000-0000-4000-8000-000000000005'
         AND verified_trader_id = 'activate-primary-target'
         AND linked_trader_count = 3
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = '51000000-0000-4000-8000-000000000002'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '60000000-0000-4000-8000-000000000006'
         AND verified_trader_id = 'unlink-remaining'
         AND linked_trader_count = 1
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = '61000000-0000-4000-8000-000000000002'
         AND is_primary
     )
     OR EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '80000000-0000-4000-8000-000000000008'
         AND verified_trader_id = 'ban-b'
     )
     OR EXISTS (
       SELECT 1 FROM auth.users
       WHERE id = '70000000-0000-4000-8000-000000000007'
     ) THEN
    RAISE EXCEPTION 'primary lifecycle concurrency left an inconsistent projection';
  END IF;
END
$final_projection_proof$;
SQL

echo "primary trader account lifecycle PostgreSQL 17 proof passed"
