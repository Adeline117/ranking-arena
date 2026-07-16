#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20260716100000. It owns an isolated
# temporary cluster and never connects to a developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LINKED_MIGRATION="$ROOT_DIR/supabase/migrations/20260715235000_atomic_linked_trader_mutations.sql"
CLAIM_MIGRATION="$ROOT_DIR/supabase/migrations/20260716100000_atomic_trader_claim_activation.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-trader-claim-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
REVERSE_LOG="$TMP_ROOT/reverse-order.log"
GATE_LOG="$TMP_ROOT/concurrency-gate.log"
CLAIM_A_LOG="$TMP_ROOT/concurrency-a.log"
CLAIM_B_LOG="$TMP_ROOT/concurrency-b.log"
PORT=55463
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in \
      "$REVERSE_LOG" \
      "$GATE_LOG" \
      "$CLAIM_A_LOG" \
      "$CLAIM_B_LOG" \
      "$LOG_FILE"; do
      if [[ -f "$diagnostic" ]]; then
        echo "--- ${diagnostic##*/} ---" >&2
        tail -120 "$diagnostic" >&2 || true
      fi
    done
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

# Build the production-shaped tables first, but intentionally omit every
# migration foundation named by the new migration's explicit preflight.
psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);

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
  verification_method text NOT NULL
    CHECK (verification_method IN ('api_key', 'signature', 'video', 'social')),
  verification_data jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewing', 'verified', 'rejected')),
  reject_reason text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trader_id, source)
);

CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verification_method text NOT NULL,
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

CREATE TABLE public.user_exchange_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  passphrase_encrypted text,
  is_active boolean NOT NULL DEFAULT true,
  verified_uid text,
  scope_permissions jsonb,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, exchange)
);

CREATE TABLE public.trader_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  trader_id text NOT NULL,
  encrypted_api_key text NOT NULL,
  encrypted_api_secret text NOT NULL,
  encrypted_passphrase text,
  permissions jsonb NOT NULL DEFAULT
    '["read_positions", "read_orders", "read_balance"]'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  last_verified_at timestamptz,
  read_only_verified_at timestamptz,
  verification_error text,
  data_source text NOT NULL DEFAULT 'authorized',
  sync_frequency text DEFAULT 'realtime',
  last_sync_at timestamptz,
  last_sync_status text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, trader_id)
);
SQL

# Reversing the migration order must fail inside its BEGIN block and leave no
# callable function behind.
if psql_cmd -f "$CLAIM_MIGRATION" >"$REVERSE_LOG" 2>&1; then
  echo "Claim activation migration unexpectedly succeeded before foundations" >&2
  exit 1
fi
if ! grep -q \
  'atomic linked-trader and Arena claimed foundations must exist before claim activation' \
  "$REVERSE_LOG"; then
  echo "Reverse-order failure did not come from the explicit preflight" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT to_regprocedure('public.activate_trader_claim(uuid,uuid)') IS NULL")" != "t" ]]; then
  echo "Reverse-order migration left a partial claim activation function" >&2
  exit 1
fi

# Install the real linked-trader transaction boundary, then a production-shaped
# Arena source/trader projection used by the claim activation migration.
psql_cmd -f "$LINKED_MIGRATION" >/dev/null
psql_cmd <<'SQL'
CREATE SCHEMA arena;
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

INSERT INTO arena.sources (slug, meta) VALUES
  ('binance', '{"legacy_platform":"binance_futures"}'::jsonb),
  ('bybit', '{}'::jsonb),
  ('okx', '{}'::jsonb);

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
  SELECT id
  INTO v_source_id
  FROM arena.sources
  WHERE slug = p_platform OR meta->>'legacy_platform' = p_platform
  LIMIT 1;

  IF v_source_id IS NULL THEN
    RAISE EXCEPTION 'unknown platform %', p_platform;
  END IF;

  INSERT INTO arena.traders (source_id, exchange_trader_id, meta)
  VALUES (v_source_id, p_trader_key, '{}'::jsonb)
  ON CONFLICT (source_id, exchange_trader_id) DO NOTHING;

  UPDATE arena.traders
  SET meta = coalesce(meta, '{}'::jsonb)
    || CASE
      WHEN p_claimed THEN jsonb_build_object(
        'claimed', true,
        'claimed_at', now(),
        'claimed_by_user_id', p_user_id::text
      )
      ELSE jsonb_build_object('claimed', false)
    END
  WHERE source_id = v_source_id
    AND exchange_trader_id = p_trader_key
  RETURNING id INTO v_trader_id;

  RETURN v_trader_id;
END;
$arena$;

REVOKE ALL ON FUNCTION public.arena_set_trader_claimed(text, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_set_trader_claimed(text, text, uuid, boolean)
  TO service_role;
SQL

psql_cmd -f "$CLAIM_MIGRATION" >/dev/null

# Stable identities make every projection and rollback assertion explicit.
psql_cmd <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555'),
  ('66666666-6666-6666-6666-666666666666'),
  ('77777777-7777-7777-7777-777777777777'),
  ('88888888-8888-8888-8888-888888888888'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.user_profiles (id)
SELECT id
FROM auth.users
WHERE id <> '33333333-3333-3333-3333-333333333333'
  AND id NOT IN (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  );

INSERT INTO public.user_exchange_connections (
  id,
  user_id,
  exchange,
  api_key_encrypted,
  api_secret_encrypted,
  passphrase_encrypted,
  is_active,
  verified_uid,
  scope_permissions,
  last_verified_at
) VALUES
  (
    'e1000000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'binance',
    'cipher-key-v1',
    'cipher-secret-v1',
    NULL,
    true,
    'api-1',
    '["read_positions", "read_balance"]'::jsonb,
    '2026-07-15 12:00:00+00'
  ),
  (
    'e7000000-0000-0000-0000-000000000007',
    '77777777-7777-7777-7777-777777777777',
    'binance',
    'bad-key',
    'bad-secret',
    NULL,
    true,
    'somebody-else',
    '[]'::jsonb,
    '2026-07-15 12:00:00+00'
  );

-- This linked identity intentionally has no verified_traders twin. Activation
-- by user 2 must roll back the verified row it inserts before discovering the
-- junction ownership conflict.
INSERT INTO public.user_linked_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary,
  display_order,
  verification_method
) VALUES (
  '44000000-0000-0000-0000-000000000001',
  '44444444-4444-4444-4444-444444444444',
  'owned-elsewhere',
  'okx',
  true,
  0,
  'signature'
);
UPDATE public.user_profiles
SET is_verified_trader = true,
    verified_trader_id = 'owned-elsewhere',
    verified_trader_source = 'okx',
    linked_trader_count = 1
WHERE id = '44444444-4444-4444-4444-444444444444';

INSERT INTO public.trader_claims (
  id, user_id, trader_id, source, verification_method, status, reject_reason
) VALUES
  (
    '10000000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'api-1',
    'binance_futures',
    'api_key',
    'pending',
    NULL
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'sig-2',
    'bybit',
    'signature',
    'reviewing',
    NULL
  ),
  (
    '20000000-0000-0000-0000-000000000001',
    '22222222-2222-2222-2222-222222222222',
    'owned-elsewhere',
    'okx',
    'signature',
    'pending',
    NULL
  ),
  (
    '30000000-0000-0000-0000-000000000001',
    '33333333-3333-3333-3333-333333333333',
    'missing-profile',
    'bybit',
    'signature',
    'pending',
    NULL
  ),
  (
    '50000000-0000-0000-0000-000000000001',
    '55555555-5555-5555-5555-555555555555',
    'rejected-trader',
    'bybit',
    'signature',
    'rejected',
    'ownership proof failed'
  ),
  (
    '60000000-0000-0000-0000-000000000001',
    '66666666-6666-6666-6666-666666666666',
    'unknown-source',
    'phantom_dex',
    'signature',
    'pending',
    NULL
  ),
  (
    '70000000-0000-0000-0000-000000000001',
    '77777777-7777-7777-7777-777777777777',
    'api-invalid',
    'binance_futures',
    'api_key',
    'pending',
    NULL
  ),
  (
    '80000000-0000-0000-0000-000000000001',
    '88888888-8888-8888-8888-888888888888',
    'concurrent-a',
    'bybit',
    'signature',
    'pending',
    NULL
  ),
  (
    '80000000-0000-0000-0000-000000000002',
    '88888888-8888-8888-8888-888888888888',
    'concurrent-b',
    'okx',
    'signature',
    'pending',
    NULL
  );
SQL

# The function itself must be service-only. Exercise a denied authenticated
# call as well as catalog ACLs; the successful API activation is made while
# SET ROLE service_role is active.
psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF has_function_privilege(
       'anon', 'public.activate_trader_claim(uuid,uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.activate_trader_claim(uuid,uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.activate_trader_claim(uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'claim activation function privilege boundary failed';
  END IF;
END
$proof$;

SET ROLE authenticated;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.activate_trader_claim(
      '10000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'authenticated activation unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE service_role;
DO $proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.activate_trader_claim(
    '10000000-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );
  IF (v_result->>'linked_count')::integer <> 1
     OR v_result->>'linked_trader_id' IS NULL
     OR v_result->>'primary_link_id' IS NULL
     OR v_result->>'authorization_id' IS NULL
     OR v_result->>'arena_trader_id' IS NULL
     OR v_result#>>'{claim,status}' <> 'verified' THEN
    RAISE EXCEPTION 'API activation returned an incomplete contract: %', v_result;
  END IF;
END
$proof$;
RESET ROLE;
SQL

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE id = '10000000-0000-0000-0000-000000000001'
         AND status = 'verified'
         AND reviewed_by = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
         AND reviewed_at IS NOT NULL
         AND verified_at IS NOT NULL
         AND reject_reason IS NULL
     ) THEN
    RAISE EXCEPTION 'API claim review projection failed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND trader_id = 'api-1'
         AND source = 'binance_futures'
         AND verification_method = 'api_key'
         AND is_primary
     ) THEN
    RAISE EXCEPTION 'API verified-trader projection failed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND trader_id = 'api-1'
         AND source = 'binance_futures'
         AND verification_method = 'api_key'
         AND is_primary
         AND display_order = 0
     ) THEN
    RAISE EXCEPTION 'API linked-trader projection failed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-1111-1111-111111111111'
         AND is_verified_trader
         AND verified_trader_id = 'api-1'
         AND verified_trader_source = 'binance_futures'
         AND linked_trader_count = 1
     ) THEN
    RAISE EXCEPTION 'API profile projection failed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND platform = 'binance_futures'
         AND trader_id = 'api-1'
         AND encrypted_api_key = 'cipher-key-v1'
         AND encrypted_api_secret = 'cipher-secret-v1'
         AND encrypted_passphrase IS NULL
         AND permissions = '["read_positions", "read_balance"]'::jsonb
         AND read_only_verified_at = '2026-07-15 12:00:00+00'
         AND last_verified_at = '2026-07-15 12:00:00+00'
         AND status = 'active'
         AND last_sync_at IS NULL
         AND last_sync_status = 'pending'
         AND consecutive_failures = 0
         AND verification_error IS NULL
     ) THEN
    RAISE EXCEPTION 'API authorization projection failed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM arena.traders AS trader
       JOIN arena.sources AS source ON source.id = trader.source_id
       WHERE source.slug = 'binance'
         AND trader.exchange_trader_id = 'api-1'
         AND trader.meta->>'claimed' = 'true'
         AND trader.meta->>'claimed_by_user_id'
           = '11111111-1111-1111-1111-111111111111'
     ) THEN
    RAISE EXCEPTION 'API Arena projection failed';
  END IF;
END
$proof$;
SQL

# A replay reconciles projections but must preserve a healthy sync when the
# encrypted credentials and permissions are unchanged. It also preserves the
# first reviewer and review timestamps.
psql_cmd <<'SQL'
DO $proof$
DECLARE
  v_reviewed_at timestamptz;
  v_verified_at timestamptz;
BEGIN
  UPDATE public.trader_authorizations
  SET last_sync_at = '2026-07-16 01:02:03+00',
      last_sync_status = 'success',
      consecutive_failures = 0,
      verification_error = NULL
  WHERE user_id = '11111111-1111-1111-1111-111111111111'
    AND platform = 'binance_futures'
    AND trader_id = 'api-1';

  SELECT reviewed_at, verified_at
  INTO STRICT v_reviewed_at, v_verified_at
  FROM public.trader_claims
  WHERE id = '10000000-0000-0000-0000-000000000001';

  PERFORM public.activate_trader_claim(
    '10000000-0000-0000-0000-000000000001',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  );

  IF NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND platform = 'binance_futures'
         AND trader_id = 'api-1'
         AND last_sync_at = '2026-07-16 01:02:03+00'
         AND last_sync_status = 'success'
         AND consecutive_failures = 0
         AND verification_error IS NULL
     )
     OR (SELECT count(*) FROM public.trader_authorizations
         WHERE user_id = '11111111-1111-1111-1111-111111111111'
           AND platform = 'binance_futures'
           AND trader_id = 'api-1') <> 1
     OR (SELECT count(*) FROM public.user_linked_traders
         WHERE user_id = '11111111-1111-1111-1111-111111111111') <> 1
     OR (SELECT count(*) FROM public.verified_traders
         WHERE user_id = '11111111-1111-1111-1111-111111111111') <> 1 THEN
    RAISE EXCEPTION 'idempotent replay duplicated rows or reset healthy sync';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE id = '10000000-0000-0000-0000-000000000001'
         AND reviewed_by = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
         AND reviewed_at = v_reviewed_at
         AND verified_at = v_verified_at
     ) THEN
    RAISE EXCEPTION 'idempotent replay rewrote first-review metadata';
  END IF;
END
$proof$;
SQL

# A non-API second claim must not replace the primary or create an
# authorization. Counts are recomputed from the junction rather than incremented.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $proof$
BEGIN
  PERFORM public.activate_trader_claim(
    '10000000-0000-0000-0000-000000000002',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF (SELECT count(*)
      FROM public.user_linked_traders
      WHERE user_id = '11111111-1111-1111-1111-111111111111') <> 2
     OR (SELECT count(*)
         FROM public.user_linked_traders
         WHERE user_id = '11111111-1111-1111-1111-111111111111'
           AND is_primary) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND trader_id = 'api-1'
         AND source = 'binance_futures'
         AND is_primary
         AND display_order = 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND trader_id = 'sig-2'
         AND source = 'bybit'
         AND NOT is_primary
         AND display_order = 1
     )
     OR (SELECT count(*)
         FROM public.verified_traders
         WHERE user_id = '11111111-1111-1111-1111-111111111111'
           AND is_primary) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-1111-1111-111111111111'
         AND verified_trader_id = 'api-1'
         AND verified_trader_source = 'binance_futures'
         AND linked_trader_count = 2
     )
     OR (SELECT count(*)
         FROM public.trader_authorizations
         WHERE user_id = '11111111-1111-1111-1111-111111111111') <> 1 THEN
    RAISE EXCEPTION 'second signature claim changed primary, count, or authorization';
  END IF;
END
$proof$;
SQL

# Every failure is caught in its own PL/pgSQL subtransaction. Assertions after
# the calls prove that earlier projections made inside the function rolled back.
psql_cmd <<'SQL'
DO $proof$
BEGIN
  BEGIN
    PERFORM public.activate_trader_claim(
      '20000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'ownership conflict unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.activate_trader_claim(
      '50000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'rejected claim unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.activate_trader_claim(
      '30000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'missing-profile claim unexpectedly succeeded';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;

  BEGIN
    PERFORM public.activate_trader_claim(
      '60000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'unknown Arena source claim unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;

  BEGIN
    PERFORM public.activate_trader_claim(
      '70000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'invalid API connection claim unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END
$proof$;

DO $proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = 'owned-elsewhere' AND source = 'okx'
     )
     OR (SELECT count(*) FROM public.user_linked_traders
         WHERE trader_id = 'owned-elsewhere' AND source = 'okx') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE trader_id = 'owned-elsewhere'
         AND source = 'okx'
         AND user_id = '44444444-4444-4444-4444-444444444444'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.trader_claims
       WHERE id = '20000000-0000-0000-0000-000000000001'
         AND status = 'pending'
         AND reviewed_by IS NULL
         AND reviewed_at IS NULL
         AND verified_at IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM arena.traders WHERE exchange_trader_id = 'owned-elsewhere'
     ) THEN
    RAISE EXCEPTION 'ownership-conflict rollback failed';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id IN (
         'rejected-trader',
         'missing-profile',
         'unknown-source',
         'api-invalid'
       )
     )
     OR EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE trader_id IN (
         'rejected-trader',
         'missing-profile',
         'unknown-source',
         'api-invalid'
       )
     )
     OR EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE trader_id IN (
         'rejected-trader',
         'missing-profile',
         'unknown-source',
         'api-invalid'
       )
     )
     OR EXISTS (
       SELECT 1 FROM arena.traders
       WHERE exchange_trader_id IN (
         'rejected-trader',
         'missing-profile',
         'unknown-source',
         'api-invalid'
       )
     ) THEN
    RAISE EXCEPTION 'failed activation left a partial trader projection';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.trader_claims
       WHERE id = '50000000-0000-0000-0000-000000000001'
         AND status = 'rejected'
         AND reject_reason = 'ownership proof failed'
         AND verified_at IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE id IN (
         '30000000-0000-0000-0000-000000000001',
         '60000000-0000-0000-0000-000000000001',
         '70000000-0000-0000-0000-000000000001'
       )
         AND (
           status <> 'pending'
           OR reviewed_by IS NOT NULL
           OR reviewed_at IS NOT NULL
           OR verified_at IS NOT NULL
         )
     ) THEN
    RAISE EXCEPTION 'failed activation changed claim review state';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id IN (
         '22222222-2222-2222-2222-222222222222',
         '55555555-5555-5555-5555-555555555555',
         '66666666-6666-6666-6666-666666666666',
         '77777777-7777-7777-7777-777777777777'
       )
         AND (
           is_verified_trader
           OR verified_trader_id IS NOT NULL
           OR verified_trader_source IS NOT NULL
           OR linked_trader_count <> 0
         )
     ) THEN
    RAISE EXCEPTION 'failed activation changed a profile projection';
  END IF;
END
$proof$;
SQL

# Hold the exact per-user advisory key used by the RPC. Two service-role
# clients start and block on it; pg_stat_activity proves both are waiting before
# release, so the final invariant is a real concurrency proof.
psql_cmd <<'SQL'
CREATE TABLE public.claim_activation_test_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  released boolean NOT NULL DEFAULT false
);
CREATE FUNCTION public.claim_activation_test_wait()
RETURNS void
LANGUAGE plpgsql
AS $wait$
BEGIN
  LOOP
    EXIT WHEN (
      SELECT released FROM public.claim_activation_test_gate WHERE singleton
    );
    PERFORM pg_sleep(0.02);
  END LOOP;
END;
$wait$;
SQL

PGAPPNAME=claim_concurrency_gate psql_cmd >"$GATE_LOG" 2>&1 <<'SQL' &
SELECT pg_advisory_lock(
  hashtextextended(
    'linked-trader:88888888-8888-8888-8888-888888888888',
    0
  )
);
INSERT INTO public.claim_activation_test_gate DEFAULT VALUES;
SELECT public.claim_activation_test_wait();
SELECT pg_advisory_unlock(
  hashtextextended(
    'linked-trader:88888888-8888-8888-8888-888888888888',
    0
  )
);
SQL
GATE_PID=$!

GATE_READY=false
for ((attempt = 0; attempt < 200; attempt += 1)); do
  if [[ "$(psql_cmd -Atqc \
    'SELECT coalesce(bool_or(NOT released), false) FROM public.claim_activation_test_gate')" \
    == "t" ]]; then
    GATE_READY=true
    break
  fi
  sleep 0.02
done
if [[ "$GATE_READY" != "true" ]]; then
  echo "Concurrency gate did not acquire the linked-trader advisory lock" >&2
  exit 1
fi

PGAPPNAME=claim_concurrency_a psql_cmd \
  -c "SET ROLE service_role; SELECT public.activate_trader_claim('80000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');" \
  >"$CLAIM_A_LOG" 2>&1 &
CLAIM_A_PID=$!
PGAPPNAME=claim_concurrency_b psql_cmd \
  -c "SET ROLE service_role; SELECT public.activate_trader_claim('80000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');" \
  >"$CLAIM_B_LOG" 2>&1 &
CLAIM_B_PID=$!

BOTH_BLOCKED=false
for ((attempt = 0; attempt < 300; attempt += 1)); do
  BLOCKED_COUNT="$(psql_cmd -Atqc \
    "SELECT count(*) FROM pg_stat_activity
     WHERE application_name IN ('claim_concurrency_a', 'claim_concurrency_b')
       AND wait_event_type = 'Lock'
       AND wait_event = 'advisory'")"
  if [[ "$BLOCKED_COUNT" == "2" ]]; then
    BOTH_BLOCKED=true
    break
  fi
  sleep 0.02
done

psql_cmd -c \
  'UPDATE public.claim_activation_test_gate SET released = true WHERE singleton' \
  >/dev/null

CONCURRENCY_FAILED=0
wait "$CLAIM_A_PID" || CONCURRENCY_FAILED=1
wait "$CLAIM_B_PID" || CONCURRENCY_FAILED=1
wait "$GATE_PID" || CONCURRENCY_FAILED=1
if [[ "$BOTH_BLOCKED" != "true" ]]; then
  echo "Both claim clients were not observed waiting on the advisory lock" >&2
  exit 1
fi
if ((CONCURRENCY_FAILED != 0)); then
  echo "A concurrent claim activation client failed" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $proof$
DECLARE
  v_primary public.user_linked_traders%ROWTYPE;
BEGIN
  IF (SELECT count(*)
      FROM public.user_linked_traders
      WHERE user_id = '88888888-8888-8888-8888-888888888888') <> 2
     OR (SELECT count(DISTINCT display_order)
         FROM public.user_linked_traders
         WHERE user_id = '88888888-8888-8888-8888-888888888888') <> 2
     OR (SELECT min(display_order)
         FROM public.user_linked_traders
         WHERE user_id = '88888888-8888-8888-8888-888888888888') <> 0
     OR (SELECT max(display_order)
         FROM public.user_linked_traders
         WHERE user_id = '88888888-8888-8888-8888-888888888888') <> 1
     OR (SELECT count(*)
         FROM public.user_linked_traders
         WHERE user_id = '88888888-8888-8888-8888-888888888888'
           AND is_primary) <> 1
     OR (SELECT count(*)
         FROM public.verified_traders
         WHERE user_id = '88888888-8888-8888-8888-888888888888'
           AND is_primary) <> 1
     OR (SELECT count(*)
         FROM public.trader_claims
         WHERE id IN (
           '80000000-0000-0000-0000-000000000001',
           '80000000-0000-0000-0000-000000000002'
         )
           AND status = 'verified') <> 2
     OR (SELECT count(*)
         FROM arena.traders
         WHERE exchange_trader_id IN ('concurrent-a', 'concurrent-b')
           AND meta->>'claimed' = 'true') <> 2 THEN
    RAISE EXCEPTION 'concurrent activation count/order/primary projection failed';
  END IF;

  SELECT linked.*
  INTO STRICT v_primary
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = '88888888-8888-8888-8888-888888888888'
    AND linked.is_primary;

  IF v_primary.display_order <> 0
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '88888888-8888-8888-8888-888888888888'
         AND is_verified_trader
         AND verified_trader_id = v_primary.trader_id
         AND verified_trader_source = v_primary.source
         AND linked_trader_count = 2
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE user_id = '88888888-8888-8888-8888-888888888888'
         AND trader_id = v_primary.trader_id
         AND source = v_primary.source
         AND is_primary
     ) THEN
    RAISE EXCEPTION 'concurrent primary mirrors drifted across projections';
  END IF;
END
$proof$;
SQL

echo "atomic trader claim activation PG17 proof passed ($PG_VERSION)"
