#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20260729065000. It owns an isolated
# temporary cluster and never connects to a developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729065000_atomic_trader_claim_revocation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

PG_VERSION="$("$PG_BIN/postgres" --version)"
if [[ ! "$PG_VERSION" =~ ^postgres\ \(PostgreSQL\)\ 17\. ]]; then
  echo "PostgreSQL 17 is required, found: $PG_VERSION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-trader-revocation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55489
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
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -d postgres \
    "$@"
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

SERVER_VERSION_NUM="$(psql_cmd -Atqc 'SHOW server_version_num')"
if ((SERVER_VERSION_NUM < 170000 || SERVER_VERSION_NUM >= 180000)); then
  echo "Isolated server is not PostgreSQL 17: $SERVER_VERSION_NUM" >&2
  exit 1
fi

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE EXTENSION pgcrypto;

CREATE SCHEMA auth;
CREATE SCHEMA arena;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_verified_trader boolean NOT NULL DEFAULT false,
  verified_trader_id text,
  verified_trader_source text,
  linked_trader_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.trader_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  handle text,
  verification_method text NOT NULL,
  verification_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT trader_claims_status_check
    CHECK (status IN ('pending', 'reviewing', 'verified', 'rejected', 'expired')),
  reject_reason text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX trader_claims_one_active_identity_uidx
  ON public.trader_claims (trader_id, source)
  WHERE status IN ('pending', 'reviewing', 'verified');

CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  display_name text,
  bio text,
  avatar_url text,
  twitter_url text,
  telegram_url text,
  discord_url text,
  website_url text,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verification_method text NOT NULL,
  can_pin_posts boolean NOT NULL DEFAULT false,
  can_reply_reviews boolean NOT NULL DEFAULT true,
  can_receive_messages boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trader_id, source)
);

CREATE TABLE public.user_linked_traders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  market_type text DEFAULT 'futures',
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verification_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, trader_id, source),
  UNIQUE (trader_id, source)
);
CREATE UNIQUE INDEX user_linked_traders_one_primary_per_user
  ON public.user_linked_traders (user_id)
  WHERE is_primary IS TRUE;

CREATE TABLE public.trader_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  trader_id text NOT NULL,
  encrypted_api_key text NOT NULL,
  encrypted_api_secret text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  verification_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, trader_id)
);

CREATE TABLE public.user_exchange_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  verified_uid text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, exchange)
);

CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  exchange_trader_id text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, exchange_trader_id)
);

CREATE OR REPLACE FUNCTION public.arena_set_trader_claimed(
  p_platform text,
  p_trader_key text,
  p_user_id uuid,
  p_claimed boolean
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = arena, public
AS $arena$
DECLARE
  v_source_id smallint;
  v_trader_id bigint;
BEGIN
  SELECT source_row.id
  INTO v_source_id
  FROM arena.sources AS source_row
  WHERE source_row.slug = p_platform
     OR source_row.meta->>'legacy_platform' = p_platform
  LIMIT 1;

  IF v_source_id IS NULL THEN
    RAISE EXCEPTION 'unknown platform %', p_platform;
  END IF;

  INSERT INTO arena.traders (source_id, exchange_trader_id)
  VALUES (v_source_id, p_trader_key)
  ON CONFLICT (source_id, exchange_trader_id) DO NOTHING;

  -- A deterministic failure sentinel proves the outer revocation rolls back.
  IF p_platform = 'broken' AND p_claimed IS FALSE THEN
    RETURN NULL;
  END IF;

  UPDATE arena.traders
  SET meta = COALESCE(meta, '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
         'claimed',
         p_claimed,
         'claimed_by_user_id',
         p_user_id::text
       )
  WHERE source_id = v_source_id
    AND exchange_trader_id = p_trader_key
  RETURNING id INTO v_trader_id;

  RETURN v_trader_id;
END;
$arena$;

CREATE OR REPLACE FUNCTION public.activate_trader_claim(
  p_claim_id uuid,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE sql
AS $stub$
  SELECT pg_catalog.jsonb_build_object(
    'claim_id', p_claim_id,
    'reviewer_id', p_reviewer_id
  )
$stub$;

CREATE OR REPLACE FUNCTION public.unlink_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS TABLE (
  remaining_count integer,
  removed_trader_id text,
  removed_source text,
  promoted_link_id uuid
)
LANGUAGE sql
AS $stub$
  SELECT 0, NULL::text, NULL::text, NULL::uuid
  WHERE p_user_id IS NULL AND p_link_id IS NULL
$stub$;

CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $stub$
BEGIN
  RETURN NEW;
END;
$stub$;
CREATE TRIGGER trader_claim_activation_expiry_guard
  BEFORE UPDATE OF status ON public.trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_trader_claim_activation_expiry();

INSERT INTO arena.sources (slug) VALUES
  ('binance_futures'),
  ('bybit'),
  ('okx'),
  ('broken');

INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles (id)
SELECT id FROM auth.users;

INSERT INTO public.user_linked_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary,
  display_order,
  verification_method
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'api-primary',
    'binance_futures',
    true,
    0,
    'api_key'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'wallet-secondary',
    'bybit',
    false,
    1,
    'signature'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222',
    'legacy-link',
    'okx',
    true,
    0,
    'signature'
  ),
  (
    '30000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333',
    'rollback-link',
    'broken',
    true,
    0,
    'api_key'
  );

INSERT INTO public.verified_traders (
  user_id,
  trader_id,
  source,
  verification_method,
  is_primary
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'api-primary',
    'binance_futures',
    'api_key',
    true
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    'wallet-secondary',
    'bybit',
    'signature',
    false
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'rollback-link',
    'broken',
    'api_key',
    true
  );

INSERT INTO public.trader_claims (
  id,
  user_id,
  trader_id,
  source,
  verification_method,
  status,
  verified_at
) VALUES
  (
    '41000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'api-primary',
    'binance_futures',
    'api_key',
    'verified',
    now()
  ),
  (
    '41000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'wallet-secondary',
    'bybit',
    'signature',
    'verified',
    now()
  ),
  (
    '43000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333',
    'rollback-link',
    'broken',
    'api_key',
    'verified',
    now()
  );

INSERT INTO public.trader_authorizations (
  user_id,
  platform,
  trader_id,
  encrypted_api_key,
  encrypted_api_secret,
  status
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'binance_futures',
    'api-primary',
    'cipher-key',
    'cipher-secret',
    'active'
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'broken',
    'rollback-link',
    'rollback-key',
    'rollback-secret',
    'active'
  );

INSERT INTO public.user_exchange_connections (
  user_id,
  exchange,
  api_key_encrypted,
  api_secret_encrypted,
  verified_uid,
  is_active
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'binance',
    'cipher-key',
    'cipher-secret',
    'api-primary',
    true
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'broken',
    'rollback-key',
    'rollback-secret',
    'rollback-link',
    true
  );

SELECT public.arena_set_trader_claimed(
  linked.source,
  linked.trader_id,
  linked.user_id,
  true
)
FROM public.user_linked_traders AS linked;

UPDATE public.user_profiles AS profile
SET is_verified_trader = true,
    verified_trader_id = primary_link.trader_id,
    verified_trader_source = primary_link.source,
    linked_trader_count = counts.linked_count
FROM public.user_linked_traders AS primary_link
JOIN (
  SELECT user_id, count(*)::integer AS linked_count
  FROM public.user_linked_traders
  GROUP BY user_id
) AS counts USING (user_id)
WHERE profile.id = primary_link.user_id
  AND primary_link.is_primary IS TRUE;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE user_id = '22222222-2222-4222-8222-222222222222'
         AND trader_id = 'legacy-link'
         AND source = 'okx'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE user_id = '22222222-2222-4222-8222-222222222222'
         AND trader_id = 'legacy-link'
         AND source = 'okx'
         AND status = 'verified'
     ) THEN
    RAISE EXCEPTION 'legacy linked-trader projection repair failed';
  END IF;

  IF has_function_privilege(
       'anon', 'public.unlink_linked_trader(uuid,uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.unlink_linked_trader(uuid,uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.unlink_linked_trader(uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'revocation function privilege boundary failed';
  END IF;
END
$proof$;

SET ROLE authenticated;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.unlink_linked_trader(
      '11111111-1111-4111-8111-111111111111',
      '10000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'authenticated revocation unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE service_role;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.unlink_linked_trader(
      '22222222-2222-4222-8222-222222222222',
      '10000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-user revocation unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = '10000000-0000-4000-8000-000000000001'
         AND user_id = '11111111-1111-4111-8111-111111111111'
     ) THEN
    RAISE EXCEPTION 'cross-user revocation changed the owner row';
  END IF;
END
$proof$;

SET ROLE service_role;
DO $proof$
DECLARE
  v_result record;
BEGIN
  SELECT *
  INTO STRICT v_result
  FROM public.unlink_linked_trader(
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000001'
  );

  IF v_result.remaining_count <> 1
     OR v_result.removed_trader_id <> 'api-primary'
     OR v_result.removed_source <> 'binance_futures'
     OR v_result.promoted_link_id
          <> '10000000-0000-4000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'primary revocation returned an invalid contract: %', v_result;
  END IF;
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = '10000000-0000-4000-8000-000000000001'
     )
     OR EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE trader_id = 'api-primary'
         AND source = 'binance_futures'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE id = '41000000-0000-4000-8000-000000000001'
         AND status = 'revoked'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE user_id = '11111111-1111-4111-8111-111111111111'
         AND platform = 'binance_futures'
         AND trader_id = 'api-primary'
         AND status = 'revoked'
     )
     OR EXISTS (
       SELECT 1
       FROM public.user_exchange_connections
       WHERE user_id = '11111111-1111-4111-8111-111111111111'
         AND exchange = 'binance'
         AND verified_uid = 'api-primary'
         AND is_active
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = '10000000-0000-4000-8000-000000000002'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE user_id = '11111111-1111-4111-8111-111111111111'
         AND trader_id = 'wallet-secondary'
         AND source = 'bybit'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND is_verified_trader
         AND verified_trader_id = 'wallet-secondary'
         AND verified_trader_source = 'bybit'
         AND linked_trader_count = 1
     )
     OR NOT EXISTS (
       SELECT 1
       FROM arena.traders AS trader
       JOIN arena.sources AS source_row
         ON source_row.id = trader.source_id
       WHERE source_row.slug = 'binance_futures'
         AND trader.exchange_trader_id = 'api-primary'
         AND trader.meta->>'claimed' = 'false'
     ) THEN
    RAISE EXCEPTION 'primary ownership revocation left a stale projection';
  END IF;

  BEGIN
    UPDATE public.trader_claims
    SET status = 'verified'
    WHERE id = '41000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'revoked claim was reactivated directly';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  IF NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE id = '41000000-0000-4000-8000-000000000001'
         AND status = 'revoked'
     ) THEN
    RAISE EXCEPTION 'failed direct reactivation changed revoked history';
  END IF;

  INSERT INTO public.trader_claims (
    user_id,
    trader_id,
    source,
    verification_method,
    status
  ) VALUES (
    '11111111-1111-4111-8111-111111111111',
    'api-primary',
    'binance_futures',
    'api_key',
    'reviewing'
  );
END
$proof$;

SET ROLE service_role;
DO $proof$
DECLARE
  v_result record;
BEGIN
  SELECT *
  INTO STRICT v_result
  FROM public.unlink_linked_trader(
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000002'
  );

  IF v_result.remaining_count <> 0
     OR v_result.promoted_link_id IS NOT NULL THEN
    RAISE EXCEPTION 'last-link revocation returned an invalid contract: %', v_result;
  END IF;
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND NOT is_verified_trader
         AND verified_trader_id IS NULL
         AND verified_trader_source IS NULL
         AND linked_trader_count = 0
     ) THEN
    RAISE EXCEPTION 'last-link revocation left a verified profile projection';
  END IF;
END
$proof$;

SET ROLE service_role;
DO $proof$
BEGIN
  PERFORM public.unlink_linked_trader(
    '22222222-2222-4222-8222-222222222222',
    '20000000-0000-4000-8000-000000000001'
  );
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE user_id = '22222222-2222-4222-8222-222222222222'
         AND trader_id = 'legacy-link'
         AND source = 'okx'
         AND status = 'revoked'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '22222222-2222-4222-8222-222222222222'
         AND NOT is_verified_trader
         AND linked_trader_count = 0
     ) THEN
    RAISE EXCEPTION 'repaired legacy identity was not revocable';
  END IF;
END
$proof$;

SET ROLE service_role;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.unlink_linked_trader(
      '33333333-3333-4333-8333-333333333333',
      '30000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Arena NULL revocation unexpectedly committed';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = '30000000-0000-4000-8000-000000000001'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE user_id = '33333333-3333-4333-8333-333333333333'
         AND trader_id = 'rollback-link'
         AND source = 'broken'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE id = '43000000-0000-4000-8000-000000000001'
         AND status = 'verified'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE user_id = '33333333-3333-4333-8333-333333333333'
         AND platform = 'broken'
         AND trader_id = 'rollback-link'
         AND status = 'active'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections
       WHERE user_id = '33333333-3333-4333-8333-333333333333'
         AND exchange = 'broken'
         AND verified_uid = 'rollback-link'
         AND is_active
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '33333333-3333-4333-8333-333333333333'
         AND is_verified_trader
         AND verified_trader_id = 'rollback-link'
         AND verified_trader_source = 'broken'
         AND linked_trader_count = 1
     )
     OR NOT EXISTS (
       SELECT 1
       FROM arena.traders AS trader
       JOIN arena.sources AS source_row
         ON source_row.id = trader.source_id
       WHERE source_row.slug = 'broken'
         AND trader.exchange_trader_id = 'rollback-link'
         AND trader.meta->>'claimed' = 'true'
     ) THEN
    RAISE EXCEPTION 'failed Arena revocation did not roll every projection back';
  END IF;
END
$proof$;
SQL

echo "atomic trader claim revocation PostgreSQL 17 proof passed"
