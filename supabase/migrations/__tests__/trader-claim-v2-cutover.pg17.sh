#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the two-phase trader-claim V2 cutover. It
# never connects to an application or production database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PHASE_A="$ROOT_DIR/supabase/migrations/20260803213000_trader_claim_v2_rpcs.sql"
PHASE_B="$ROOT_DIR/supabase/migrations/20260803214000_trader_claim_v2_cutover.sql"
CANONICAL_ACTIVATION="$ROOT_DIR/supabase/migrations/20260716100000_atomic_trader_claim_activation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/trader-claim-v2-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local name="$1"
  local sql="$2"
  if psql_cmd -c "$sql" >"$TMP_ROOT/$name.log" 2>&1; then
    echo "expected failure succeeded: $name" >&2
    exit 1
  fi
}

submit_v2() {
  local trader_id="$1"
  local challenge_id="$2"
  local user_id="${3:-11111111-1111-1111-1111-111111111111}"
  psql_cmd -Atqc "
    SET ROLE service_role;
    WITH proof AS (
      SELECT pg_catalog.date_trunc(
               'milliseconds',
               pg_catalog.statement_timestamp() - interval '1 second'
             ) AS issued_at
    ), material AS (
      SELECT
        issued_at,
        issued_at + interval '1 second' AS verified_at,
        'Arena Trader Claim' || E'\\n' ||
        'Domain: www.arenafi.org' || E'\\n' ||
        'User ID: $user_id' || E'\\n' ||
        'Source: hyperliquid' || E'\\n' ||
        'Trader ID: $trader_id' || E'\\n' ||
        'Nonce: $challenge_id' || E'\\n' ||
        'Issued At: ' || pg_catalog.to_char(
          issued_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'
        ) || E'\\n' ||
        'Expiration Time: ' || pg_catalog.to_char(
          (issued_at + interval '5 minutes') AT TIME ZONE 'UTC',
          'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'
        ) AS message
      FROM proof
    )
    SELECT
      claim.status || ':' || claim.submission_version::text || ':' ||
      (claim.verification_data->>'proof_version')
    FROM material
    CROSS JOIN LATERAL public.submit_trader_claim_v2(
      '$user_id'::uuid,
      '$trader_id',
      'hyperliquid',
      '$challenge_id',
      material.issued_at,
      material.verified_at,
      pg_catalog.encode(extensions.digest(material.message, 'sha256'), 'hex'),
      pg_catalog.repeat('b', 64)
    ) AS claim;
  "
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
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE hostile_claim_admin NOLOGIN BYPASSRLS;
CREATE ROLE inherited_profile_writer NOLOGIN NOBYPASSRLS;

CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE SCHEMA arena;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$$;
GRANT USAGE ON SCHEMA auth, public, extensions, arena
  TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public
  TO hostile_claim_admin, inherited_profile_writer;
GRANT EXECUTE ON FUNCTION auth.uid()
  TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  is_verified_trader boolean DEFAULT false,
  verified_trader_id text,
  verified_trader_source text,
  linked_trader_count integer DEFAULT 0,
  handle text,
  updated_at timestamptz DEFAULT pg_catalog.now()
);
INSERT INTO public.user_profiles(id) SELECT id FROM auth.users;

CREATE TABLE public.trader_claims (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  trader_id text NOT NULL,
  source text NOT NULL,
  handle text,
  verification_method text NOT NULL,
  verification_data jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewing', 'verified', 'rejected', 'expired')),
  reject_reason text,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now()
);
CREATE UNIQUE INDEX trader_claims_one_active_identity_uidx
  ON public.trader_claims(trader_id, source)
  WHERE status IN ('pending', 'reviewing', 'verified');

CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  trader_id text NOT NULL,
  source text NOT NULL,
  display_name text,
  bio text,
  avatar_url text,
  twitter_url text,
  telegram_url text,
  discord_url text,
  website_url text,
  verified_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  verification_method text NOT NULL,
  can_pin_posts boolean DEFAULT false,
  can_reply_reviews boolean DEFAULT true,
  can_receive_messages boolean DEFAULT true,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now(),
  UNIQUE (trader_id, source)
);

CREATE TABLE public.user_linked_traders (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  trader_id text NOT NULL,
  source text NOT NULL,
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  verified_at timestamptz DEFAULT pg_catalog.now(),
  verification_method text NOT NULL,
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now(),
  UNIQUE (trader_id, source)
);
CREATE UNIQUE INDEX user_linked_traders_one_primary_per_user
  ON public.user_linked_traders(user_id)
  WHERE is_primary IS TRUE;

CREATE TABLE public.user_exchange_connections (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  passphrase_encrypted text,
  is_active boolean DEFAULT true,
  verified_uid text,
  last_verified_at timestamptz,
  scope_permissions jsonb,
  updated_at timestamptz DEFAULT pg_catalog.now(),
  UNIQUE (user_id, exchange)
);

CREATE TABLE public.trader_authorizations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  platform text NOT NULL,
  trader_id text NOT NULL,
  encrypted_api_key text NOT NULL,
  encrypted_api_secret text NOT NULL,
  encrypted_passphrase text,
  permissions jsonb,
  status text NOT NULL,
  read_only_verified_at timestamptz,
  last_verified_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  verification_error text,
  label text,
  sync_frequency text,
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now()
);

-- Historical migrations install one shared timestamp trigger function for
-- claims/connections and a dedicated authorization timestamp function.
CREATE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trigger_trader_claims_updated_at
  BEFORE UPDATE ON public.trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_user_exchange_connections_updated_at
  BEFORE UPDATE ON public.user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION public.update_trader_authorizations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trigger_update_trader_authorizations_updated_at
  BEFORE UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_trader_authorizations_updated_at();

CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO arena.sources(slug) VALUES
  ('hyperliquid'), ('gmx'), ('binance'), ('bybit'), ('okx'), ('bitget');

CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, exchange_trader_id)
);

-- Compatibility view keeps the existing proof assertions readable while the
-- fixture now exercises the real Arena schema and metadata ownership contract.
CREATE VIEW public.arena_claim_state AS
SELECT
  source_row.slug AS source,
  trader.exchange_trader_id AS trader_id,
  NULLIF(trader.meta->>'claimed_by_user_id', '')::uuid AS user_id,
  COALESCE((trader.meta->>'claimed')::boolean, false) AS claimed
FROM arena.traders AS trader
JOIN arena.sources AS source_row ON source_row.id = trader.source_id;

CREATE FUNCTION public.seed_arena_claim_state_view()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_source_id smallint;
BEGIN
  SELECT source_row.id INTO STRICT v_source_id
  FROM arena.sources AS source_row
  WHERE source_row.slug = NEW.source;

  INSERT INTO arena.traders(source_id, exchange_trader_id, meta)
  VALUES (
    v_source_id,
    NEW.trader_id,
    pg_catalog.jsonb_build_object(
      'claimed', NEW.claimed,
      'claimed_by_user_id', NEW.user_id::text,
      'claimed_at', pg_catalog.statement_timestamp()
    )
  )
  ON CONFLICT (source_id, exchange_trader_id) DO UPDATE
  SET meta = EXCLUDED.meta;
  RETURN NEW;
END
$$;
CREATE TRIGGER seed_arena_claim_state_view
  INSTEAD OF INSERT ON public.arena_claim_state
  FOR EACH ROW EXECUTE FUNCTION public.seed_arena_claim_state_view();

CREATE FUNCTION public.arena_set_trader_claimed(
  p_platform text,
  p_trader_key text,
  p_user_id uuid,
  p_claimed boolean
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_trader_id bigint;
BEGIN
  INSERT INTO public.arena_claim_state(source, trader_id, user_id, claimed)
  VALUES (p_platform, p_trader_key, p_user_id, p_claimed);
  SELECT trader.id INTO STRICT v_trader_id
  FROM arena.traders AS trader
  JOIN arena.sources AS source_row ON source_row.id = trader.source_id
  WHERE source_row.slug = p_platform
    AND trader.exchange_trader_id = p_trader_key;
  RETURN v_trader_id;
END
$$;

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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT 0, NULL::text, NULL::text, NULL::uuid WHERE false
$$;

CREATE FUNCTION public.set_primary_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS public.user_linked_traders
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT linked.*
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id AND linked.user_id = p_user_id
$$;

ALTER TABLE public.trader_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verified_traders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_linked_traders ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.trader_claims, public.verified_traders
  TO PUBLIC, anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE public.trader_authorizations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_exchange_connections
  TO service_role;
-- Hostile dashboard drift: Phase B must dynamically remove broad linked-row
-- DML/table/column grants and unknown policies, not merely known policy names.
GRANT ALL PRIVILEGES ON TABLE public.user_linked_traders
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (user_id), UPDATE (is_primary)
  ON TABLE public.user_linked_traders
  TO PUBLIC, anon, authenticated, service_role;
CREATE POLICY "Hostile public linked trader access"
  ON public.user_linked_traders FOR ALL TO public
  USING (true) WITH CHECK (true);
CREATE POLICY "Unknown dashboard linked trader writer"
  ON public.user_linked_traders FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- A table UPDATE grant overrides a per-column revoke. Exercise both forms on
-- every profile identity projection that Phase B must return to server-only.
GRANT UPDATE ON TABLE public.user_profiles TO PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.user_profiles TO service_role;
GRANT UPDATE (
  is_verified_trader,
  verified_trader_id,
  verified_trader_source,
  linked_trader_count
) ON TABLE public.user_profiles TO PUBLIC, anon, authenticated;
-- The ingestion worker keeps broad Arena row DML. Phase B must reserve only
-- claimed-owner metadata, rather than relying on an unrelated table ACL error.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE arena.traders TO service_role;
GRANT SELECT ON TABLE arena.sources TO service_role;
GRANT UPDATE (status, verification_data), INSERT (status, verification_data)
  ON public.trader_claims TO service_role;
CREATE POLICY "Service role can manage all claims"
  ON public.trader_claims FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "Unknown dashboard claim drift"
  ON public.trader_claims FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);
CREATE POLICY "Service role can manage verified traders"
  ON public.verified_traders FOR ALL TO service_role
  USING (true) WITH CHECK (true);

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
AS $$
DECLARE
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  INSERT INTO public.trader_claims(
    user_id, trader_id, source, verification_method, verification_data, status
  ) VALUES (
    p_user_id, p_trader_id, p_source, p_verification_method,
    p_verification_data, 'reviewing'
  ) RETURNING * INTO v_claim;
  RETURN v_claim;
END
$$;

CREATE FUNCTION public.guard_trader_claim_activation_expiry()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END
$$;
CREATE TRIGGER trader_claim_activation_expiry_guard
  BEFORE UPDATE OF status ON public.trader_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_trader_claim_activation_expiry();

GRANT EXECUTE ON FUNCTION public.submit_trader_claim(uuid,text,text,text,jsonb)
  TO service_role;

INSERT INTO public.trader_claims(
  id, user_id, trader_id, source, verification_method, verification_data, status
) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
   '11111111-1111-1111-1111-111111111111',
   'legacy-pending', 'binance_futures', 'api_key', '{}', 'pending'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
   '22222222-2222-2222-2222-222222222222',
   'legacy-verified', 'bybit', 'api_key', '{}', 'verified');

INSERT INTO public.trader_authorizations(
  id, user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
  encrypted_passphrase, permissions, status, read_only_verified_at, last_verified_at,
  last_sync_status
) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
   '11111111-1111-1111-1111-111111111111',
   'hyperliquid', '0xlegacywallet', 'wallet-signature', 'wallet-signature',
   NULL, '["wallet_owner"]', 'active', NULL, NULL, 'pending'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
   '11111111-1111-1111-1111-111111111111',
   'binance', 'incomplete-account', 'cipher-key', 'cipher-secret',
   NULL, '["read"]', 'active', NULL, NULL, 'pending'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
   '22222222-2222-2222-2222-222222222222',
   'okx', 'valid-account', 'cipher-key', 'cipher-secret',
   'cipher-passphrase', '["read_only"]', 'active',
   '2026-08-03 00:00:00+00'::timestamptz,
   '2026-08-03 00:00:00+00'::timestamptz, 'pending');

INSERT INTO public.user_exchange_connections(
  user_id, exchange, api_key_encrypted, api_secret_encrypted,
  passphrase_encrypted, is_active, verified_uid, last_verified_at,
  scope_permissions
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  'okx', 'cipher-key', 'cipher-secret', 'cipher-passphrase', true,
  'valid-account', '2026-08-03 00:00:00+00'::timestamptz,
  '["read_only"]'
);
SQL

# Use the repository's real atomic activation migration. A deliberately weak
# fixture stub could let Phase B pass while linked/profile projections were
# never written, which is exactly the regression this proof must catch.
psql_cmd -q -f "$CANONICAL_ACTIVATION"

# A same-name unique partial index is not enough: key order, lack of included
# or expression columns, access method, and the full active predicate are part
# of the activation ownership contract.
psql_cmd -q <<'SQL'
ALTER INDEX public.trader_claims_one_active_identity_uidx
  RENAME TO trader_claims_one_active_identity_correct_fixture;
CREATE UNIQUE INDEX trader_claims_one_active_identity_uidx
  ON public.trader_claims(source, trader_id)
  WHERE status IN ('pending', 'reviewing');
SQL
if psql_cmd -q -f "$PHASE_A" >"$TMP_ROOT/wrong-active-index.log" 2>&1; then
  echo 'Phase A accepted a hostile same-name active identity index' >&2
  exit 1
fi
psql_cmd -q <<'SQL'
DROP INDEX public.trader_claims_one_active_identity_uidx;
ALTER INDEX public.trader_claims_one_active_identity_correct_fixture
  RENAME TO trader_claims_one_active_identity_uidx;
SQL

if psql_cmd -q -c 'SET ROLE service_role' -f "$PHASE_A" \
  >"$TMP_ROOT/phase-a-owner-mismatch.log" 2>&1; then
  echo 'Phase A accepted a migration executor that does not own trader_claims' >&2
  exit 1
fi
if ! grep -q 'Phase-A migration role must own trader_claims' \
  "$TMP_ROOT/phase-a-owner-mismatch.log"; then
  echo 'Phase A owner mismatch did not fail at the explicit ownership preflight' >&2
  exit 1
fi

psql_cmd -q -c \
  "CREATE FUNCTION public.submit_trader_claim_v2(text) RETURNS text LANGUAGE sql AS 'SELECT \$1'"
if psql_cmd -q -f "$PHASE_A" >"$TMP_ROOT/phase-a-overload.log" 2>&1; then
  echo 'Phase A accepted an unknown claim overload' >&2
  exit 1
fi
if ! grep -q 'unexpected trader-claim function overloads' \
  "$TMP_ROOT/phase-a-overload.log"; then
  cat "$TMP_ROOT/phase-a-overload.log" >&2
  exit 1
fi
psql_cmd -q -c 'DROP FUNCTION public.submit_trader_claim_v2(text)'

# A direct ACL scan cannot see role inheritance. Phase A must refuse to leave
# its compatibility writer effectively executable by a browser role.
psql_cmd -q -c 'GRANT service_role TO anon'
if psql_cmd -q -f "$PHASE_A" >"$TMP_ROOT/phase-a-inherited-submit.log" 2>&1; then
  echo 'Phase A accepted inherited browser access to legacy submit' >&2
  exit 1
fi
if ! grep -q 'Phase-A legacy submit effective capability boundary is incorrect' \
  "$TMP_ROOT/phase-a-inherited-submit.log"; then
  cat "$TMP_ROOT/phase-a-inherited-submit.log" >&2
  exit 1
fi
psql_cmd -q -c 'REVOKE service_role FROM anon'

psql_cmd -q -f "$PHASE_A"

# CREATE OR REPLACE must not preserve a substituted canonical-function owner on
# byte replay. Include callable, closed legacy, and trigger-only capabilities.
psql_cmd -q <<'SQL'
GRANT CREATE ON SCHEMA public TO hostile_claim_admin;
ALTER FUNCTION public.submit_trader_claim(uuid,text,text,text,jsonb)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.submit_trader_claim_v2(
  uuid,text,text,text,timestamptz,timestamptz,text,text
) OWNER TO hostile_claim_admin;
ALTER FUNCTION public.reject_trader_claim_v2(uuid,uuid,text)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.cancel_trader_claim_v2(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.activate_trader_claim(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.arena_set_trader_claimed(text,text,uuid,boolean)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.guard_trader_claim_activation_expiry()
  OWNER TO hostile_claim_admin;
SET ROLE hostile_claim_admin;
CREATE OR REPLACE FUNCTION public.submit_trader_claim(
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
AS $hostile$
BEGIN
  RAISE EXCEPTION 'hostile legacy submit body executed';
END;
$hostile$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM hostile_claim_admin;
SQL

psql_cmd -q -f "$PHASE_A"

psql_cmd -q <<'SQL'
DO $phase_a_owner_replay_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid IN (
      'public.submit_trader_claim(uuid,text,text,text,jsonb)'::regprocedure,
      'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure,
      'public.reject_trader_claim_v2(uuid,uuid,text)'::regprocedure,
      'public.cancel_trader_claim_v2(uuid,uuid)'::regprocedure,
      'public.activate_trader_claim(uuid,uuid)'::regprocedure,
      'public.arena_set_trader_claimed(text,text,uuid,boolean)'::regprocedure,
      'public.guard_trader_claim_activation_expiry()'::regprocedure
    )
      AND procedure_row.proowner IS DISTINCT FROM (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = 'public.trader_claims'::regclass
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid =
          'public.submit_trader_claim(uuid,text,text,text,jsonb)'::regprocedure
      AND pg_catalog.encode(
            extensions.digest(procedure_row.prosrc, 'sha256'),
            'hex'
          ) = '15690f785d4524bdaa06f3a8b731d54b2eab39eaa1a79c432a67b5f5dc57aba4'
  ) THEN
    RAISE EXCEPTION 'custom Phase-A function owner or body survived replay';
  END IF;
END
$phase_a_owner_replay_proof$;
SQL

PHASE_A_COLUMN="$(
  psql_cmd -Atqc "
    SELECT submission_version
    FROM public.trader_claims
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  "
)"
if [[ "$PHASE_A_COLUMN" != '1' ]]; then
  echo "legacy rows did not receive submission_version=1: $PHASE_A_COLUMN" >&2
  exit 1
fi

# Phase A leaves only the legacy V1 submit writer callable for deployment
# compatibility. Legacy activation is revoked immediately; the trigger also
# rejects direct verified insertion as a defense-in-depth status boundary.
LEGACY_PHASE_A="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT (public.submit_trader_claim(
      '11111111-1111-1111-1111-111111111111',
      'legacy-phase-a',
      'gains',
      'signature',
      '{}'::jsonb
    )).submission_version;
  "
)"
if [[ "$LEGACY_PHASE_A" != '1' ]]; then
  echo "phase-A compatibility writer did not stay version 1: $LEGACY_PHASE_A" >&2
  exit 1
fi

expect_failure legacy_direct_verified "
  SET ROLE service_role;
  INSERT INTO public.trader_claims(
    user_id, trader_id, source, verification_method, verification_data, status
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    '0x9999999999999999999999999999999999999999',
    'hyperliquid', 'signature', '{}', 'verified'
  );
"

expect_failure legacy_activation "
  SET ROLE service_role;
  SELECT public.activate_trader_claim(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '33333333-3333-3333-3333-333333333333'
  );
"

# A historical verified V1 row must not exploit activate_trader_claim's
# idempotent path to rebuild projections. The trigger error rolls back the
# projection written earlier in the same SECURITY DEFINER transaction.
expect_failure legacy_verified_replay "
  SET ROLE service_role;
  SELECT public.activate_trader_claim(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    '33333333-3333-3333-3333-333333333333'
  );
"
LEGACY_PROJECTION_COUNT="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.count(*)
    FROM public.verified_traders
    WHERE trader_id = 'legacy-verified' AND source = 'bybit';
  "
)"
if [[ "$LEGACY_PROJECTION_COUNT" != '0' ]]; then
  echo "legacy verified replay left a projection behind: $LEGACY_PROJECTION_COUNT" >&2
  exit 1
fi

# Historical verified CEX identity used to prove that user-driven unlink closes
# every exactly mapped authority/credential projection without guessing.
psql_cmd -q <<'SQL'
INSERT INTO public.verified_traders(
  user_id, trader_id, source, verification_method, is_primary
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  'legacy-verified', 'bybit', 'api_key', true
);
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order,
  verification_method
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  '22222222-2222-2222-2222-222222222222',
  'legacy-verified', 'bybit', true, 0, 'api_key'
);
UPDATE public.user_profiles
SET is_verified_trader = true,
    verified_trader_id = 'legacy-verified',
    verified_trader_source = 'bybit',
    linked_trader_count = 1
WHERE id = '22222222-2222-2222-2222-222222222222';
INSERT INTO public.user_exchange_connections(
  user_id, exchange, api_key_encrypted, api_secret_encrypted, is_active,
  verified_uid, last_verified_at, scope_permissions
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  'bybit', 'cipher-key', 'cipher-secret', true,
  'legacy-verified', '2026-08-03 00:00:00+00'::timestamptz, '["read_only"]'
), (
  '22222222-2222-2222-2222-222222222222',
  'bybit_spot', 'cipher-alias-key', 'cipher-alias-secret', true,
  'legacy-verified', '2026-08-03 00:00:00+00'::timestamptz, '["read_only"]'
);
INSERT INTO public.trader_authorizations(
  id, user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
  permissions, status, read_only_verified_at, last_verified_at,
  last_sync_status
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
  '22222222-2222-2222-2222-222222222222',
  'bybit_spot', 'legacy-verified', 'cipher-key', 'cipher-secret',
  '["read_only"]', 'active',
  '2026-08-03 00:00:00+00'::timestamptz,
  '2026-08-03 00:00:00+00'::timestamptz, 'pending'
);
INSERT INTO public.arena_claim_state(source, trader_id, user_id, claimed)
VALUES (
  'bybit', 'legacy-verified',
  '22222222-2222-2222-2222-222222222222', true
);
SQL

V2_ONE="$(submit_v2 \
  '0x1111111111111111111111111111111111111111' \
  '1111111111111111111111111111111111111111111111111111111111111111')"
if [[ "$V2_ONE" != 'reviewing:2:arena-wallet-claim@2' ]]; then
  echo "typed V2 submission mismatch: $V2_ONE" >&2
  exit 1
fi

V2_ONE_ID="$(
  psql_cmd -Atqc "
    SELECT id FROM public.trader_claims
    WHERE trader_id = '0x1111111111111111111111111111111111111111';
  "
)"
expect_failure phase_a_v2_activation_fail_closed "
  SET ROLE service_role;
  SELECT public.activate_trader_claim(
    '$V2_ONE_ID',
    '33333333-3333-3333-3333-333333333333'
  );
"
PHASE_A_V2_STATE="$(
  psql_cmd -Atqc "
    SELECT claim.status || ':' ||
      (SELECT pg_catalog.count(*) FROM public.verified_traders AS verified
       WHERE verified.trader_id = claim.trader_id
         AND verified.source = claim.source) || ':' ||
      (SELECT pg_catalog.count(*) FROM public.user_linked_traders AS linked
       WHERE linked.trader_id = claim.trader_id
         AND linked.source = claim.source)
    FROM public.trader_claims AS claim
    WHERE claim.id = '$V2_ONE_ID';
  "
)"
if [[ "$PHASE_A_V2_STATE" != 'reviewing:0:0' ]]; then
  echo "Phase-A V2 activation did not fail closed: $PHASE_A_V2_STATE" >&2
  exit 1
fi

# Phase A preserves legacy V1 submission compatibility, but the shared service
# role may neither manufacture a V2 provenance bit nor rewrite a canonical row.
expect_failure direct_v2_forge_phase_a "
  SET ROLE service_role;
  INSERT INTO public.trader_claims(
    user_id, trader_id, source, verification_method, verification_data,
    submission_version, status
  )
  SELECT
    '11111111-1111-1111-1111-111111111111',
    '0x1212121212121212121212121212121212121212',
    'hyperliquid', 'signature', verification_data, 2, 'reviewing'
  FROM public.trader_claims
  WHERE id = '$V2_ONE_ID';
"
expect_failure direct_v2_rewrite_phase_a "
  SET ROLE service_role;
  UPDATE public.trader_claims
  SET verification_data = verification_data
    || pg_catalog.jsonb_build_object('signature_sha256', pg_catalog.repeat('c', 64))
  WHERE id = '$V2_ONE_ID';
"
expect_failure direct_v2_delete_phase_a "
  SET ROLE service_role;
  DELETE FROM public.trader_claims WHERE id = '$V2_ONE_ID';
"

V2_TWO="$(submit_v2 \
  '0x2222222222222222222222222222222222222222' \
  '2222222222222222222222222222222222222222222222222222222222222222' \
  '22222222-2222-2222-2222-222222222222')"
V2_TWO_ID="$(
  psql_cmd -Atqc "SELECT id FROM public.trader_claims WHERE trader_id = '0x2222222222222222222222222222222222222222';"
)"
REJECTED="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT (public.reject_trader_claim_v2(
      '$V2_TWO_ID',
      '33333333-3333-3333-3333-333333333333',
      'fixture rejection'
    )).status;
  "
)"
if [[ "$V2_TWO" != 'reviewing:2:arena-wallet-claim@2' || "$REJECTED" != 'rejected' ]]; then
  echo "V2 rejection capability mismatch: $V2_TWO / $REJECTED" >&2
  exit 1
fi

V2_THREE="$(submit_v2 \
  '0x3333333333333333333333333333333333333333' \
  '3333333333333333333333333333333333333333333333333333333333333333')"
V2_THREE_ID="$(
  psql_cmd -Atqc "SELECT id FROM public.trader_claims WHERE trader_id = '0x3333333333333333333333333333333333333333';"
)"
CANCELLED="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT (public.cancel_trader_claim_v2(
      '$V2_THREE_ID',
      '11111111-1111-1111-1111-111111111111'
    )).status;
  "
)"
if [[ "$V2_THREE" != 'reviewing:2:arena-wallet-claim@2' || "$CANCELLED" != 'rejected' ]]; then
  echo "V2 cancellation capability mismatch: $V2_THREE / $CANCELLED" >&2
  exit 1
fi

expect_failure pre_phase_b_activate_v2 "
  SET ROLE service_role;
  SELECT public.activate_trader_claim_v2(
    '$V2_ONE_ID', '33333333-3333-3333-3333-333333333333'
  );
"
expect_failure pre_phase_b_set_primary_v2 "
  SET ROLE service_role;
  SELECT public.set_primary_linked_trader_v2(
    '22222222-2222-2222-2222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
  );
"
expect_failure pre_phase_b_unlink_v2 "
  SET ROLE service_role;
  SELECT * FROM public.unlink_linked_trader_v2(
    '22222222-2222-2222-2222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
  );
"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.unlink_linked_trader_v2(text)
RETURNS text LANGUAGE sql AS 'SELECT $1';
SQL
if psql_cmd -q -f "$PHASE_B" >"$TMP_ROOT/phase-b-overload.log" 2>&1; then
  echo 'Phase B accepted an unknown claim overload' >&2
  exit 1
fi
if ! grep -q 'unexpected trader-claim cutoff overloads' \
  "$TMP_ROOT/phase-b-overload.log"; then
  cat "$TMP_ROOT/phase-b-overload.log" >&2
  exit 1
fi
psql_cmd -q -c 'DROP FUNCTION public.unlink_linked_trader_v2(text)'

psql_cmd -q <<'SQL'
CREATE TRIGGER unexpected_claim_cutover_trigger
  BEFORE UPDATE ON public.trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
SQL
if psql_cmd -q -f "$PHASE_B" >"$TMP_ROOT/phase-b-trigger.log" 2>&1; then
  echo 'Phase B accepted an unknown pre-sweep trigger' >&2
  exit 1
fi
if ! grep -q 'unexpected claim-cutoff triggers must be retired before sweep DML' \
  "$TMP_ROOT/phase-b-trigger.log"; then
  cat "$TMP_ROOT/phase-b-trigger.log" >&2
  exit 1
fi
psql_cmd -q -c \
  'DROP TRIGGER unexpected_claim_cutover_trigger ON public.trader_claims'

psql_cmd -q <<'SQL'
GRANT ALL PRIVILEGES ON TABLE
  public.user_linked_traders,
  public.trader_claims,
  public.verified_traders
  TO hostile_claim_admin;
GRANT UPDATE (is_primary) ON TABLE public.user_linked_traders
  TO hostile_claim_admin;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.user_profiles TO hostile_claim_admin;
GRANT INSERT (
  id, is_verified_trader, verified_trader_id, verified_trader_source,
  linked_trader_count
), UPDATE (
  is_verified_trader, verified_trader_id, verified_trader_source,
  linked_trader_count
), REFERENCES (id)
  ON TABLE public.user_profiles TO hostile_claim_admin;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.user_profiles TO service_role WITH GRANT OPTION;
GRANT SELECT (id), INSERT (
  id, is_verified_trader, verified_trader_id, verified_trader_source,
  linked_trader_count
), UPDATE (
  is_verified_trader, verified_trader_id, verified_trader_source,
  linked_trader_count
), REFERENCES (id)
  ON TABLE public.user_profiles TO service_role WITH GRANT OPTION;
GRANT service_role TO inherited_profile_writer;
GRANT EXECUTE ON FUNCTION
  public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text),
  public.reject_trader_claim_v2(uuid,uuid,text),
  public.cancel_trader_claim_v2(uuid,uuid),
  public.activate_trader_claim(uuid,uuid)
  TO hostile_claim_admin;
SQL

if psql_cmd -q -c 'SET ROLE service_role' -f "$PHASE_B" \
  >"$TMP_ROOT/phase-b-owner-mismatch.log" 2>&1; then
  echo 'Phase B accepted a migration executor that does not own identity tables' >&2
  exit 1
fi
if ! grep -q 'Phase-B migration role must own trader_claims' \
  "$TMP_ROOT/phase-b-owner-mismatch.log"; then
  echo 'Phase B owner mismatch did not fail at the explicit ownership preflight' >&2
  exit 1
fi

psql_cmd -q -f "$PHASE_B"

psql_cmd -q <<'SQL'
DO $custom_acl_proof$
BEGIN
  IF pg_catalog.has_table_privilege(
       'hostile_claim_admin', 'public.trader_claims', 'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'hostile_claim_admin', 'public.verified_traders', 'UPDATE'
     ) OR pg_catalog.has_column_privilege(
       'hostile_claim_admin', 'public.user_linked_traders', 'is_primary', 'UPDATE'
     ) OR pg_catalog.has_column_privilege(
       'hostile_claim_admin', 'public.user_profiles', 'verified_trader_id', 'UPDATE'
     ) OR pg_catalog.has_table_privilege(
       'hostile_claim_admin', 'public.user_profiles', 'INSERT'
     ) OR pg_catalog.has_table_privilege(
       'hostile_claim_admin', 'public.user_profiles', 'DELETE'
     ) OR pg_catalog.has_table_privilege(
       'hostile_claim_admin', 'public.user_profiles', 'TRUNCATE'
     ) OR pg_catalog.has_any_column_privilege(
       'hostile_claim_admin', 'public.user_profiles', 'INSERT'
     ) OR pg_catalog.has_any_column_privilege(
       'hostile_claim_admin', 'public.user_profiles', 'REFERENCES'
     ) OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.user_profiles', 'SELECT'
     ) OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.user_profiles', 'INSERT'
     ) OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.user_profiles', 'UPDATE'
     ) OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.user_profiles', 'DELETE'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_profiles', 'SELECT WITH GRANT OPTION'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_profiles', 'UPDATE WITH GRANT OPTION'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_profiles', 'DELETE WITH GRANT OPTION'
     ) OR pg_catalog.has_any_column_privilege(
       'service_role', 'public.user_profiles', 'SELECT WITH GRANT OPTION'
     ) OR pg_catalog.has_any_column_privilege(
       'service_role', 'public.user_profiles', 'UPDATE WITH GRANT OPTION'
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
       WHERE attribute.attrelid = 'public.user_profiles'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
         AND acl_entry.privilege_type = 'SELECT'
     ) OR pg_catalog.has_function_privilege(
       'hostile_claim_admin',
       'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'hostile_claim_admin',
       'public.activate_trader_claim(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'custom claim ACL survived Phase B';
  END IF;
END
$custom_acl_proof$;
SQL

psql_cmd -q <<'SQL'
SET ROLE authenticated;
UPDATE public.user_profiles SET handle = 'retained-safe-edit';
RESET ROLE;

DO $safe_profile_update_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_profiles
    WHERE handle = 'retained-safe-edit'
  ) <> 3 THEN
    RAISE EXCEPTION 'authenticated safe profile UPDATE did not survive Phase B';
  END IF;
END
$safe_profile_update_proof$;
SQL

psql_cmd -q -c \
  "INSERT INTO auth.users(id) VALUES ('99999999-9999-4999-8999-999999999999')"

expect_failure hostile_bypassrls_profile_insert "
  SET ROLE hostile_claim_admin;
  INSERT INTO public.user_profiles(
    id, is_verified_trader, verified_trader_id, verified_trader_source,
    linked_trader_count
  ) VALUES (
    '99999999-9999-4999-8999-999999999999', true,
    'forged-bypassrls-owner', 'hyperliquid', 1
  );
"
expect_failure inherited_service_profile_forged_insert "
  SET ROLE inherited_profile_writer;
  INSERT INTO public.user_profiles(
    id, is_verified_trader, verified_trader_id, verified_trader_source,
    linked_trader_count
  ) VALUES (
    '99999999-9999-4999-8999-999999999999', true,
    'forged-inherited-owner', 'hyperliquid', 1
  );
"
if ! grep -q 'trader identity profile fields are RPC-owned' \
  "$TMP_ROOT/inherited_service_profile_forged_insert.log"; then
  cat "$TMP_ROOT/inherited_service_profile_forged_insert.log" >&2
  exit 1
fi

NEUTRAL_PROFILE_INSERT="$(
  psql_cmd -Atqc "
    SET ROLE inherited_profile_writer;
    INSERT INTO public.user_profiles(id, is_verified_trader, linked_trader_count)
    VALUES ('99999999-9999-4999-8999-999999999999', NULL, NULL)
    RETURNING id;
  "
)"
if [[ "$NEUTRAL_PROFILE_INSERT" != '99999999-9999-4999-8999-999999999999' ]]; then
  echo "inherited neutral profile insert failed: $NEUTRAL_PROFILE_INSERT" >&2
  exit 1
fi

expect_failure inherited_service_authoritative_profile_delete "
  SET ROLE inherited_profile_writer;
  DELETE FROM public.user_profiles
  WHERE id = '22222222-2222-2222-2222-222222222222';
"
if ! grep -q 'trader identity profile fields are RPC-owned' \
  "$TMP_ROOT/inherited_service_authoritative_profile_delete.log"; then
  cat "$TMP_ROOT/inherited_service_authoritative_profile_delete.log" >&2
  exit 1
fi

NEUTRAL_PROFILE_DELETE="$(
  psql_cmd -Atqc "
    SET ROLE inherited_profile_writer;
    DELETE FROM public.user_profiles
    WHERE id = '99999999-9999-4999-8999-999999999999'
    RETURNING id;
  "
)"
if [[ "$NEUTRAL_PROFILE_DELETE" != '99999999-9999-4999-8999-999999999999' ]]; then
  echo "inherited neutral profile delete failed: $NEUTRAL_PROFILE_DELETE" >&2
  exit 1
fi

CUTOFF_STATE="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.count(*) FILTER (
        WHERE submission_version = 1 AND status IN ('pending', 'reviewing')
      ) || ':' ||
      pg_catalog.count(*) FILTER (
        WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
          AND status = 'verified'
      )
    FROM public.trader_claims;
  "
)"
if [[ "$CUTOFF_STATE" != '0:1' ]]; then
  echo "legacy quarantine/history state mismatch: $CUTOFF_STATE" >&2
  exit 1
fi

AUTHORIZATION_CUTOFF_STATE="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(trader_id || ':' || status, ',' ORDER BY trader_id)
    FROM public.trader_authorizations;
  "
)"
if [[ "$AUTHORIZATION_CUTOFF_STATE" != '0xlegacywallet:revoked,incomplete-account:revoked,legacy-verified:active,valid-account:active' ]]; then
  echo "authorization quarantine mismatch: $AUTHORIZATION_CUTOFF_STATE" >&2
  exit 1
fi

expect_failure service_direct_link_insert "
  SET ROLE service_role;
  INSERT INTO public.user_linked_traders(
    user_id, trader_id, source, verification_method
  ) VALUES (
    '22222222-2222-2222-2222-222222222222',
    'direct-service-insert', 'bybit', 'api_key'
  );
"
expect_failure service_direct_link_update "
  SET ROLE service_role;
  UPDATE public.user_linked_traders SET label = 'forged'
  WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
"
expect_failure service_direct_link_delete "
  SET ROLE service_role;
  DELETE FROM public.user_linked_traders
  WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
"
expect_failure authenticated_profile_identity_update "
  SET ROLE authenticated;
  SELECT pg_catalog.set_config(
    'request.jwt.claim.sub',
    '22222222-2222-2222-2222-222222222222',
    false
  );
  UPDATE public.user_profiles SET is_verified_trader = false
  WHERE id = '22222222-2222-2222-2222-222222222222';
"

METADATA_UPDATED="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT
      (updated).label || ':' || (updated).display_order::text
    FROM (
      SELECT public.update_linked_trader_metadata_v1(
        '22222222-2222-2222-2222-222222222222',
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
        true, '  Owner label  ', true, 7
      ) AS updated
    ) AS result;
  "
)"
if [[ "$METADATA_UPDATED" != 'Owner label:7' ]]; then
  echo "metadata RPC returned the wrong row: $METADATA_UPDATED" >&2
  exit 1
fi

METADATA_DISPLAY_ONLY="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT
      (updated).label || ':' || (updated).display_order::text
    FROM (
      SELECT public.update_linked_trader_metadata_v1(
        '22222222-2222-2222-2222-222222222222',
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
        false, NULL, true, 8
      ) AS updated
    ) AS result;
  "
)"
if [[ "$METADATA_DISPLAY_ONLY" != 'Owner label:8' ]]; then
  echo "display-only metadata edit cleared the label: $METADATA_DISPLAY_ONLY" >&2
  exit 1
fi

expect_failure metadata_wrong_owner "
  SET ROLE service_role;
  SELECT public.update_linked_trader_metadata_v1(
    '11111111-1111-1111-1111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    true, 'stolen', false, NULL
  );
"
expect_failure metadata_unselected_value "
  SET ROLE service_role;
  SELECT public.update_linked_trader_metadata_v1(
    '22222222-2222-2222-2222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    false, 'ambiguous', true, 9
  );
"

psql_cmd -q <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '22222222-2222-2222-2222-222222222222',
  false
);
DO $own_link_read_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.user_linked_traders) <> 1 THEN
    RAISE EXCEPTION 'authenticated owner cannot read exactly its linked row';
  END IF;
END
$own_link_read_proof$;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111',
  false
);
DO $foreign_link_read_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.user_linked_traders) <> 0 THEN
    RAISE EXCEPTION 'authenticated reader can see another owner linked row';
  END IF;
END
$foreign_link_read_proof$;
RESET ROLE;
SQL

expect_failure service_legacy_activate_after_cutoff "
  SET ROLE service_role;
  SELECT public.activate_trader_claim(
    '$V2_ONE_ID', '33333333-3333-3333-3333-333333333333'
  );
"
expect_failure service_legacy_set_primary_after_cutoff "
  SET ROLE service_role;
  SELECT public.set_primary_linked_trader(
    '22222222-2222-2222-2222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
  );
"
expect_failure service_legacy_unlink_after_cutoff "
  SET ROLE service_role;
  SELECT * FROM public.unlink_linked_trader(
    '22222222-2222-2222-2222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
  );
"

PHASE_B_V2_ONE_ACTIVATED="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.activate_trader_claim_v2(
      '$V2_ONE_ID',
      '33333333-3333-3333-3333-333333333333'
    )->'claim'->>'status';
  "
)"
PHASE_B_V2_ONE_REVIEW_AUDIT="$(
  psql_cmd -Atqc "
    SELECT reviewed_by::text || ':' || reviewed_at::text || ':' || verified_at::text
    FROM public.trader_claims
    WHERE id = '$V2_ONE_ID';
  "
)"
PHASE_B_V2_ONE_REPLAY="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.activate_trader_claim_v2(
      '$V2_ONE_ID',
      '22222222-2222-2222-2222-222222222222'
    )->'claim'->>'status';
  "
)"
PHASE_B_V2_ONE_STATE="$(
  psql_cmd -Atqc "
    SELECT claim.status || ':' ||
      (claim.reviewed_by = '33333333-3333-3333-3333-333333333333'::uuid)::text || ':' ||
      (claim.reviewed_by::text || ':' || claim.reviewed_at::text || ':' || claim.verified_at::text
        = '$PHASE_B_V2_ONE_REVIEW_AUDIT')::text || ':' ||
      (SELECT pg_catalog.count(*) FROM public.verified_traders AS verified
       WHERE verified.user_id = claim.user_id
         AND verified.trader_id = claim.trader_id
         AND verified.source = claim.source) || ':' ||
      (SELECT pg_catalog.count(*) FROM public.user_linked_traders AS linked
       WHERE linked.user_id = claim.user_id
         AND linked.trader_id = claim.trader_id
         AND linked.source = claim.source)
    FROM public.trader_claims AS claim
    WHERE claim.id = '$V2_ONE_ID';
  "
)"
if [[ "$PHASE_B_V2_ONE_ACTIVATED" != 'verified' || "$PHASE_B_V2_ONE_REPLAY" != 'verified' || "$PHASE_B_V2_ONE_STATE" != 'verified:true:true:1:1' ]]; then
  echo "canonical Phase-B activation/replay mismatch: $PHASE_B_V2_ONE_ACTIVATED / $PHASE_B_V2_ONE_REPLAY / $PHASE_B_V2_ONE_STATE" >&2
  exit 1
fi

POST_PHASE_B_SUBMIT="$(submit_v2 \
  '0x4444444444444444444444444444444444444444' \
  '4444444444444444444444444444444444444444444444444444444444444444' \
  '33333333-3333-3333-3333-333333333333')"
POST_PHASE_B_ID="$(
  psql_cmd -Atqc "
    SELECT id FROM public.trader_claims
    WHERE trader_id = '0x4444444444444444444444444444444444444444';
  "
)"
POST_PHASE_B_ACTIVATED="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT
      result->'claim'->>'status' || ':' ||
      pg_catalog.jsonb_typeof(result->'linked_trader_id') || ':' ||
      pg_catalog.jsonb_typeof(result->'primary_link_id') || ':' ||
      (result->>'linked_count') || ':' ||
      ((result->'authorization_id') = 'null'::jsonb)::text || ':' ||
      pg_catalog.jsonb_typeof(result->'arena_trader_id')
    FROM (
      SELECT public.activate_trader_claim_v2(
        '$POST_PHASE_B_ID',
        '33333333-3333-3333-3333-333333333333'
      ) AS result
    ) AS activation;
  "
)"
if [[ "$POST_PHASE_B_SUBMIT" != 'reviewing:2:arena-wallet-claim@2' || "$POST_PHASE_B_ACTIVATED" != 'verified:string:string:1:true:number' ]]; then
  echo "post-Phase-B activation failed through internal Arena helper: $POST_PHASE_B_SUBMIT / $POST_PHASE_B_ACTIVATED" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
DO $post_phase_b_canonical_activation_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.arena_claim_state
       WHERE source = 'hyperliquid'
         AND trader_id = '0x4444444444444444444444444444444444444444'
         AND user_id = '33333333-3333-3333-3333-333333333333'
         AND claimed IS TRUE
     ) OR NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE user_id = '33333333-3333-3333-3333-333333333333'
         AND source = 'hyperliquid'
         AND trader_id = '0x4444444444444444444444444444444444444444'
         AND verification_method = 'signature'
         AND is_primary IS TRUE
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE user_id = '33333333-3333-3333-3333-333333333333'
         AND source = 'hyperliquid'
         AND trader_id = '0x4444444444444444444444444444444444444444'
         AND verification_method = 'signature'
         AND is_primary IS TRUE
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '33333333-3333-3333-3333-333333333333'
         AND is_verified_trader IS TRUE
         AND verified_trader_source = 'hyperliquid'
         AND verified_trader_id = '0x4444444444444444444444444444444444444444'
         AND linked_trader_count = 1
     ) OR EXISTS (
       SELECT 1 FROM public.user_exchange_connections
       WHERE user_id = '33333333-3333-3333-3333-333333333333'
     ) OR EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE user_id = '33333333-3333-3333-3333-333333333333'
         AND trader_id = '0x4444444444444444444444444444444444444444'
     ) THEN
    RAISE EXCEPTION 'Phase-B activation did not atomically build wallet projections';
  END IF;
END
$post_phase_b_canonical_activation_proof$;
SQL

expect_failure service_direct_profile_identity_update "
  SET ROLE service_role;
  UPDATE public.user_profiles
  SET verified_trader_id = 'forged-profile-owner'
  WHERE id = '33333333-3333-3333-3333-333333333333';
"
expect_failure service_direct_arena_claimed_update "
  SET ROLE service_role;
  UPDATE arena.traders AS trader
  SET meta = trader.meta || pg_catalog.jsonb_build_object(
    'claimed_by_user_id', '11111111-1111-1111-1111-111111111111'
  )
  FROM arena.sources AS source_row
  WHERE trader.source_id = source_row.id
    AND source_row.slug = 'hyperliquid'
    AND trader.exchange_trader_id = '0x4444444444444444444444444444444444444444';
"
expect_failure service_direct_arena_claimed_delete "
  SET ROLE service_role;
  DELETE FROM arena.traders AS trader
  USING arena.sources AS source_row
  WHERE trader.source_id = source_row.id
    AND source_row.slug = 'hyperliquid'
    AND trader.exchange_trader_id = '0x4444444444444444444444444444444444444444';
"
expect_failure service_direct_arena_claimed_insert "
  SET ROLE service_role;
  INSERT INTO arena.traders(source_id, exchange_trader_id, meta)
  SELECT source_row.id, 'direct-forged-meta',
    pg_catalog.jsonb_build_object(
      'claimed', true,
      'claimed_by_user_id', '33333333-3333-3333-3333-333333333333'
    )
  FROM arena.sources AS source_row
  WHERE source_row.slug = 'gmx';
"

ARENA_NON_IDENTITY_META="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    UPDATE arena.traders AS trader
    SET meta = trader.meta || pg_catalog.jsonb_build_object('worker_note', 'ok')
    FROM arena.sources AS source_row
    WHERE trader.source_id = source_row.id
      AND source_row.slug = 'hyperliquid'
      AND trader.exchange_trader_id = '0x4444444444444444444444444444444444444444'
    RETURNING trader.meta->>'worker_note';
  "
)"
if [[ "$ARENA_NON_IDENTITY_META" != 'ok' ]]; then
  echo "Arena non-identity worker metadata was blocked: $ARENA_NON_IDENTITY_META" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DELETE FROM public.user_linked_traders
WHERE trader_id = '0x4444444444444444444444444444444444444444'
  AND source = 'hyperliquid';
DELETE FROM public.verified_traders
WHERE trader_id = '0x4444444444444444444444444444444444444444'
  AND source = 'hyperliquid';
UPDATE public.user_profiles
SET is_verified_trader = false,
    verified_trader_id = NULL,
    verified_trader_source = NULL,
    linked_trader_count = 0
WHERE id = '33333333-3333-3333-3333-333333333333';
DELETE FROM public.trader_claims
WHERE trader_id = '0x4444444444444444444444444444444444444444'
  AND source = 'hyperliquid';
DELETE FROM arena.traders AS trader
USING arena.sources AS source_row
WHERE trader.source_id = source_row.id
  AND source_row.slug = 'hyperliquid'
  AND trader.exchange_trader_id = '0x4444444444444444444444444444444444444444';
SQL

expect_failure service_direct_arena_claim "
  SET ROLE service_role;
  SELECT public.arena_set_trader_claimed(
    'gmx', 'direct-capability-probe',
    '33333333-3333-3333-3333-333333333333', true
  );
"

# The real Phase-B Arena helper must reject a mismatched claimed owner and roll
# back every public unlink projection that ran before its final owner check.
psql_cmd -q <<'SQL'
INSERT INTO public.verified_traders(
  user_id, trader_id, source, verification_method, is_primary
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  'arena-wrong-owner', 'gmx', 'signature', true
);
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order,
  verification_method
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  '33333333-3333-3333-3333-333333333333',
  'arena-wrong-owner', 'gmx', true, 0, 'signature'
);
UPDATE public.user_profiles
SET is_verified_trader = true,
    verified_trader_id = 'arena-wrong-owner',
    verified_trader_source = 'gmx',
    linked_trader_count = 1
WHERE id = '33333333-3333-3333-3333-333333333333';
INSERT INTO public.arena_claim_state(source, trader_id, user_id, claimed)
VALUES (
  'gmx', 'arena-wrong-owner',
  '11111111-1111-1111-1111-111111111111', true
);
SQL

expect_failure unlink_wrong_arena_owner "
  SET ROLE service_role;
  SELECT * FROM public.unlink_linked_trader_v2(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
  );
"

psql_cmd -q <<'SQL'
DO $wrong_arena_owner_rollback_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE user_id = '33333333-3333-3333-3333-333333333333'
         AND trader_id = 'arena-wrong-owner' AND source = 'gmx'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '33333333-3333-3333-3333-333333333333'
         AND is_verified_trader
         AND verified_trader_id = 'arena-wrong-owner'
         AND linked_trader_count = 1
     ) OR NOT EXISTS (
       SELECT 1 FROM public.arena_claim_state
       WHERE source = 'gmx' AND trader_id = 'arena-wrong-owner'
         AND user_id = '11111111-1111-1111-1111-111111111111'
         AND claimed IS TRUE
     ) THEN
    RAISE EXCEPTION 'wrong Arena owner did not roll back every unlink projection';
  END IF;
END
$wrong_arena_owner_rollback_proof$;

DELETE FROM public.user_linked_traders
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
DELETE FROM public.verified_traders
WHERE trader_id = 'arena-wrong-owner' AND source = 'gmx';
DELETE FROM arena.traders AS trader
USING arena.sources AS source_row
WHERE trader.source_id = source_row.id
  AND source_row.slug = 'gmx'
  AND trader.exchange_trader_id = 'arena-wrong-owner';
UPDATE public.user_profiles
SET is_verified_trader = false,
    verified_trader_id = NULL,
    verified_trader_source = NULL,
    linked_trader_count = 0
WHERE id = '33333333-3333-3333-3333-333333333333';

INSERT INTO public.verified_traders(
  user_id, trader_id, source, verification_method, is_primary
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  'arena-missing-row', 'gmx', 'signature', true
);
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order,
  verification_method
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  '33333333-3333-3333-3333-333333333333',
  'arena-missing-row', 'gmx', true, 0, 'signature'
);
UPDATE public.user_profiles
SET is_verified_trader = true,
    verified_trader_id = 'arena-missing-row',
    verified_trader_source = 'gmx',
    linked_trader_count = 1
WHERE id = '33333333-3333-3333-3333-333333333333';
SQL

expect_failure unlink_missing_arena_row "
  SET ROLE service_role;
  SELECT * FROM public.unlink_linked_trader_v2(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
  );
"

psql_cmd -q <<'SQL'
DO $missing_arena_row_rollback_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE user_id = '33333333-3333-3333-3333-333333333333'
         AND trader_id = 'arena-missing-row' AND source = 'gmx'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
     ) OR EXISTS (
       SELECT 1 FROM public.arena_claim_state
       WHERE source = 'gmx' AND trader_id = 'arena-missing-row'
     ) THEN
    RAISE EXCEPTION 'missing Arena row was upserted or unlink failed to roll back';
  END IF;
END
$missing_arena_row_rollback_proof$;

DELETE FROM public.user_linked_traders
WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
DELETE FROM public.verified_traders
WHERE trader_id = 'arena-missing-row' AND source = 'gmx';
UPDATE public.user_profiles
SET is_verified_trader = false,
    verified_trader_id = NULL,
    verified_trader_source = NULL,
    linked_trader_count = 0
WHERE id = '33333333-3333-3333-3333-333333333333';
SQL

UNLINKED_CEX="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT remaining_count
    FROM public.unlink_linked_trader_v2(
      '22222222-2222-2222-2222-222222222222',
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
    );
  "
)"
if [[ "$UNLINKED_CEX" != '0' ]]; then
  echo "atomic CEX verified unlink returned the wrong count: $UNLINKED_CEX" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $atomic_cex_unlink_proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = 'legacy-verified' AND source = 'bybit'
     ) OR EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE trader_id = 'legacy-verified' AND source = 'bybit'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.trader_claims
       WHERE trader_id = 'legacy-verified' AND source = 'bybit'
         AND status = 'rejected'
         AND reject_reason = 'Unlinked by claimant'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '22222222-2222-2222-2222-222222222222'
         AND NOT is_verified_trader
         AND verified_trader_id IS NULL
         AND verified_trader_source IS NULL
         AND linked_trader_count = 0
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange IN ('bybit', 'bybit_spot')
         AND verified_uid = 'legacy-verified'
         AND is_active IS FALSE
       GROUP BY user_id
       HAVING pg_catalog.count(*) = 2
     ) OR NOT EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4'
         AND status = 'revoked'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.arena_claim_state
       WHERE source = 'bybit' AND trader_id = 'legacy-verified'
         AND claimed IS FALSE
     ) THEN
    RAISE EXCEPTION 'atomic CEX verified unlink left a public or credential authority';
  END IF;
END
$atomic_cex_unlink_proof$;

-- A legacy claim may point at an older account while the canonical exchange
-- connection has already moved. Revoke only the exact authorization identity;
-- never deactivate or revoke the newer account by guessing from exchange name.
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order,
  verification_method
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
  '22222222-2222-2222-2222-222222222222',
  'legacy-binance-claim', 'binance', true, 0, 'api_key'
);
INSERT INTO public.verified_traders(
  user_id, trader_id, source, verification_method, is_primary
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  'legacy-binance-claim', 'binance', 'api_key', true
);
UPDATE public.user_profiles
SET is_verified_trader = true,
    verified_trader_id = 'legacy-binance-claim',
    verified_trader_source = 'binance',
    linked_trader_count = 1
WHERE id = '22222222-2222-2222-2222-222222222222';
INSERT INTO public.arena_claim_state(source, trader_id, user_id, claimed)
VALUES (
  'binance', 'legacy-binance-claim',
  '22222222-2222-2222-2222-222222222222', true
);
INSERT INTO public.user_exchange_connections(
  user_id, exchange, api_key_encrypted, api_secret_encrypted, is_active,
  verified_uid, last_verified_at, scope_permissions
) VALUES (
  '22222222-2222-2222-2222-222222222222', 'binance',
  'cipher-newer-key', 'cipher-newer-secret', true,
  'newer-binance-account',
  '2026-08-03 00:00:00+00'::timestamptz, '["read"]'
);
INSERT INTO public.trader_authorizations(
  id, user_id, platform, trader_id, encrypted_api_key,
  encrypted_api_secret, permissions, status, read_only_verified_at,
  last_verified_at, last_sync_status
) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
   '22222222-2222-2222-2222-222222222222', 'binance_spot',
   'legacy-binance-claim', 'cipher-old-key', 'cipher-old-secret',
   '["read"]', 'revoked',
   '2026-08-03 00:00:00+00'::timestamptz,
   '2026-08-03 00:00:00+00'::timestamptz, 'success'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6',
   '22222222-2222-2222-2222-222222222222', 'binance',
   'newer-binance-account', 'cipher-newer-key', 'cipher-newer-secret',
   '["read"]', 'active',
   '2026-08-03 00:00:00+00'::timestamptz,
   '2026-08-03 00:00:00+00'::timestamptz, 'success');

SET ROLE service_role;
SELECT * FROM public.unlink_linked_trader_v2(
  '22222222-2222-2222-2222-222222222222',
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc5'
);
RESET ROLE;

DO $ambiguous_cex_unlink_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange = 'binance'
         AND verified_uid = 'newer-binance-account'
         AND is_active
     ) OR NOT EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
         AND status = 'revoked'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6'
         AND status = 'active'
     ) OR EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = 'legacy-binance-claim' AND source = 'binance'
     ) OR EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE trader_id = 'legacy-binance-claim' AND source = 'binance'
     ) THEN
    RAISE EXCEPTION 'ambiguous CEX unlink guessed at a newer account projection';
  END IF;
END
$ambiguous_cex_unlink_proof$;

-- Build two exact wallet projections to prove deterministic primary promotion.
UPDATE public.user_linked_traders
SET id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
    is_primary = true,
    display_order = 0
WHERE user_id = '11111111-1111-1111-1111-111111111111'
  AND trader_id = '0x1111111111111111111111111111111111111111'
  AND source = 'hyperliquid';
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order,
  verification_method
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
   '11111111-1111-1111-1111-111111111111',
   '0xabababababababababababababababababababab',
   'gmx', false, 1, 'signature'
);
INSERT INTO public.verified_traders(
  user_id, trader_id, source, verification_method, is_primary
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  '0xabababababababababababababababababababab',
  'gmx', 'signature', false
);
UPDATE public.verified_traders
SET is_primary = true
WHERE trader_id = '0x1111111111111111111111111111111111111111'
  AND source = 'hyperliquid';
UPDATE public.user_profiles
SET is_verified_trader = true,
    verified_trader_id = '0x1111111111111111111111111111111111111111',
    verified_trader_source = 'hyperliquid',
    linked_trader_count = 2
WHERE id = '11111111-1111-1111-1111-111111111111';
INSERT INTO public.arena_claim_state(source, trader_id, user_id, claimed)
VALUES
  ('hyperliquid', '0x1111111111111111111111111111111111111111',
   '11111111-1111-1111-1111-111111111111', true),
  ('gmx', '0xabababababababababababababababababababab',
   '11111111-1111-1111-1111-111111111111', true);
SQL

SET_PRIMARY_GMX="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT (public.set_primary_linked_trader_v2(
      '11111111-1111-1111-1111-111111111111',
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
    )).source;
  "
)"
if [[ "$SET_PRIMARY_GMX" != 'gmx' ]]; then
  echo "atomic set-primary returned the wrong identity: $SET_PRIMARY_GMX" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
DO $set_primary_projection_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
         AND is_primary IS TRUE
     ) OR EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
         AND is_primary IS TRUE
     ) OR NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND trader_id = '0xabababababababababababababababababababab'
         AND source = 'gmx' AND is_primary IS TRUE
     ) OR EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND trader_id = '0x1111111111111111111111111111111111111111'
         AND source = 'hyperliquid' AND is_primary IS TRUE
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '11111111-1111-1111-1111-111111111111'
         AND verified_trader_id = '0xabababababababababababababababababababab'
         AND verified_trader_source = 'gmx'
         AND linked_trader_count = 2
     ) THEN
    RAISE EXCEPTION 'set-primary left linked/verified/profile projections split';
  END IF;
END
$set_primary_projection_proof$;
SQL

# Restore the original target through the same RPC so the following unlink
# proof still exercises deterministic promotion from primary to survivor.
SET_PRIMARY_HYPERLIQUID="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT (public.set_primary_linked_trader_v2(
      '11111111-1111-1111-1111-111111111111',
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
    )).source;
  "
)"
if [[ "$SET_PRIMARY_HYPERLIQUID" != 'hyperliquid' ]]; then
  echo "atomic set-primary restore failed: $SET_PRIMARY_HYPERLIQUID" >&2
  exit 1
fi

PROMOTED_LINK="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT remaining_count::text || ':' || promoted_link_id::text
    FROM public.unlink_linked_trader_v2(
      '11111111-1111-1111-1111-111111111111',
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
    );
  "
)"
if [[ "$PROMOTED_LINK" != '1:cccccccc-cccc-4ccc-8ccc-ccccccccccc3' ]]; then
  echo "verified unlink primary promotion mismatch: $PROMOTED_LINK" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $primary_promotion_proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = '0x1111111111111111111111111111111111111111'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = '0xabababababababababababababababababababab'
         AND source = 'gmx' AND is_primary
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '11111111-1111-1111-1111-111111111111'
         AND is_verified_trader
         AND verified_trader_id = '0xabababababababababababababababababababab'
         AND verified_trader_source = 'gmx'
         AND linked_trader_count = 1
     ) THEN
    RAISE EXCEPTION 'verified unlink did not update primary/profile authority';
  END IF;
END
$primary_promotion_proof$;

-- A late profile-write failure must roll back earlier verified/link deletes.
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order,
  verification_method
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
  '33333333-3333-3333-3333-333333333333',
  '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  'gmx', true, 0, 'signature'
);
INSERT INTO public.verified_traders(
  user_id, trader_id, source, verification_method, is_primary
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  'gmx', 'signature', true
);
UPDATE public.user_profiles
SET is_verified_trader = true,
    verified_trader_id = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    verified_trader_source = 'gmx',
    linked_trader_count = 1
WHERE id = '33333333-3333-3333-3333-333333333333';
INSERT INTO public.arena_claim_state(source, trader_id, user_id, claimed)
VALUES (
  'gmx', '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  '33333333-3333-3333-3333-333333333333', true
);

CREATE FUNCTION public.reject_unlink_profile_fixture()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id = '33333333-3333-3333-3333-333333333333' THEN
    RAISE EXCEPTION 'forced unlink profile failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER reject_unlink_profile_fixture
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.reject_unlink_profile_fixture();
SQL

expect_failure unlink_late_write_rollback "
  SET ROLE service_role;
  SELECT * FROM public.unlink_linked_trader_v2(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'
  );
"

psql_cmd -q <<'SQL'
DO $unlink_rollback_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
         AND source = 'gmx'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '33333333-3333-3333-3333-333333333333'
         AND is_verified_trader
         AND linked_trader_count = 1
     ) OR NOT EXISTS (
       SELECT 1 FROM public.arena_claim_state
       WHERE trader_id = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
         AND claimed
     ) THEN
    RAISE EXCEPTION 'failed unlink did not roll back every authority projection';
  END IF;
END
$unlink_rollback_proof$;
DROP TRIGGER reject_unlink_profile_fixture ON public.user_profiles;
DROP FUNCTION public.reject_unlink_profile_fixture();

-- The Arena projection is the last write. A failure there must still restore
-- every public projection changed earlier in the function.
CREATE OR REPLACE FUNCTION public.arena_set_trader_claimed(
  p_platform text,
  p_trader_key text,
  p_user_id uuid,
  p_claimed boolean
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_trader_key = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.arena_claim_state(source, trader_id, user_id, claimed)
  VALUES (p_platform, p_trader_key, p_user_id, p_claimed)
  ON CONFLICT (source, trader_id) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      claimed = EXCLUDED.claimed;
  RETURN 1;
END
$function$;
SQL

expect_failure unlink_arena_write_rollback "
  SET ROLE service_role;
  SELECT * FROM public.unlink_linked_trader_v2(
    '33333333-3333-3333-3333-333333333333',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'
  );
"

psql_cmd -q <<'SQL'
DO $unlink_arena_rollback_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE trader_id = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
         AND source = 'gmx'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '33333333-3333-3333-3333-333333333333'
         AND is_verified_trader
         AND linked_trader_count = 1
     ) OR NOT EXISTS (
       SELECT 1 FROM public.arena_claim_state
       WHERE trader_id = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
         AND claimed
     ) THEN
    RAISE EXCEPTION 'Arena failure did not roll back every unlink authority projection';
  END IF;
END
$unlink_arena_rollback_proof$;
SQL

expect_failure authenticated_unlink_v2_rpc_after_cutoff "
  SET ROLE authenticated;
  SELECT * FROM public.unlink_linked_trader_v2(
    '11111111-1111-1111-1111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
  );
"

expect_failure anonymous_unlink_v2_rpc_after_cutoff "
  SET ROLE anon;
  SELECT * FROM public.unlink_linked_trader_v2(
    '11111111-1111-1111-1111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
  );
"

expect_failure legacy_wallet_authorization_after_cutoff "
  SET ROLE service_role;
  INSERT INTO public.trader_authorizations(
    user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
    permissions, status
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'gmx', '0xnewlegacywallet', 'wallet-signature', 'wallet-signature',
    '[\"wallet_owner\"]', 'active'
  );
"
expect_failure incomplete_authorization_after_cutoff "
  SET ROLE service_role;
  INSERT INTO public.trader_authorizations(
    user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
    permissions, status
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'binance', 'new-incomplete', 'cipher-key', 'cipher-secret',
    '[\"read\"]', 'active'
  );
"
expect_failure authorization_first_after_cutoff "
  SET ROLE service_role;
  INSERT INTO public.trader_authorizations(
    user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
    encrypted_passphrase, permissions, status, read_only_verified_at,
    last_verified_at, last_sync_status
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'bitget', 'auth-first-complete', 'cipher-key', 'cipher-secret',
    'cipher-passphrase', '[\"read_only\"]', 'active',
    pg_catalog.transaction_timestamp(), pg_catalog.transaction_timestamp(),
    'pending'
  );
"

VALID_AUTHORIZATION="$(
  psql_cmd -Atqc "
    BEGIN;
    SET ROLE service_role;
    INSERT INTO public.user_exchange_connections(
      user_id, exchange, api_key_encrypted, api_secret_encrypted,
      is_active, verified_uid, last_verified_at, scope_permissions
    ) VALUES (
      '11111111-1111-1111-1111-111111111111',
      'bybit', 'cipher-key', 'cipher-secret', true, 'new-valid',
      pg_catalog.transaction_timestamp(), '[\"read_only\"]'
    );
    INSERT INTO public.trader_authorizations(
      user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
      permissions, status, read_only_verified_at, last_verified_at,
      last_sync_status
    ) VALUES (
      '11111111-1111-1111-1111-111111111111',
      'bybit', 'new-valid', 'cipher-key', 'cipher-secret',
      '[\"read_only\"]', 'active', pg_catalog.transaction_timestamp(),
      pg_catalog.transaction_timestamp(),
      'pending'
    ) RETURNING status;
    COMMIT;
  "
)"
if [[ "$VALID_AUTHORIZATION" != 'active' ]]; then
  echo "valid read-only authorization was rejected: $VALID_AUTHORIZATION" >&2
  exit 1
fi

expect_failure old_rpc_after_cutoff "
  SET ROLE service_role;
  SELECT public.submit_trader_claim(
    '11111111-1111-1111-1111-111111111111',
    'legacy-after-cutoff', 'gains', 'signature', '{}'::jsonb
  );
"
expect_failure direct_claim_insert_after_cutoff "
  SET ROLE service_role;
  INSERT INTO public.trader_claims(
    user_id, trader_id, source, verification_method, verification_data, status
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'direct-after-cutoff', 'gains', 'signature', '{}', 'reviewing'
  );
"
expect_failure direct_claim_update_after_cutoff "
  SET ROLE service_role;
  UPDATE public.trader_claims SET status = 'verified'
  WHERE id = '$V2_TWO_ID';
"
expect_failure direct_claim_delete_after_cutoff "
  SET ROLE service_role;
  DELETE FROM public.trader_claims WHERE id = '$V2_TWO_ID';
"

psql_cmd -q <<'SQL'
INSERT INTO public.verified_traders(
  user_id, trader_id, source, verification_method, display_name
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'hyperliquid', 'signature', 'before'
);
SQL

expect_failure direct_verified_insert_after_cutoff "
  SET ROLE service_role;
  INSERT INTO public.verified_traders(
    user_id, trader_id, source, verification_method
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'hyperliquid', 'signature'
  );
"
expect_failure direct_verified_delete_after_cutoff "
  SET ROLE service_role;
  DELETE FROM public.verified_traders
  WHERE trader_id = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
"
expect_failure unsafe_verified_update_after_cutoff "
  SET ROLE service_role;
  UPDATE public.verified_traders SET verification_method = 'api_key'
  WHERE trader_id = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
"

SAFE_PROFILE_UPDATE="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    UPDATE public.verified_traders SET display_name = 'after'
    WHERE trader_id = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    RETURNING display_name;
  "
)"
if [[ "$SAFE_PROFILE_UPDATE" != 'after' ]]; then
  echo "safe verified profile update failed: $SAFE_PROFILE_UPDATE" >&2
  exit 1
fi

V2_FOUR="$(submit_v2 \
  '0x4444444444444444444444444444444444444444' \
  '4444444444444444444444444444444444444444444444444444444444444444')"
if [[ "$V2_FOUR" != 'reviewing:2:arena-wallet-claim@2' ]]; then
  echo "V2 writer stopped working after cutoff: $V2_FOUR" >&2
  exit 1
fi

# Replay must converge after the old RPC is already revoked and policies/ACLs
# have reached their final form.
psql_cmd -q <<'SQL'
CREATE TABLE public.claim_cutover_guard_sentinel (label text NOT NULL);
GRANT INSERT ON TABLE public.claim_cutover_guard_sentinel
  TO hostile_claim_admin;
INSERT INTO public.trader_claims (
  id, user_id, trader_id, source, verification_method, verification_data,
  submission_version, status
) VALUES (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '11111111-1111-1111-1111-111111111111',
  'claim-guard-replay', 'binance', 'api_key', '{}'::jsonb, 1, 'reviewing'
);
ALTER TABLE public.trader_authorizations
  DISABLE TRIGGER trader_authorization_v1_contract_guard;
INSERT INTO public.trader_authorizations (
  id, user_id, platform, trader_id, encrypted_api_key,
  encrypted_api_secret, permissions, status, last_sync_status
) VALUES (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  '22222222-2222-2222-2222-222222222222',
  'mexc', 'authorization-guard-replay', 'guard-replay-key',
  'guard-replay-secret', '["read"]'::jsonb, 'active', 'pending'
);
ALTER TABLE public.trader_authorizations
  ENABLE TRIGGER trader_authorization_v1_contract_guard;

GRANT CREATE ON SCHEMA public TO hostile_claim_admin;
ALTER FUNCTION public.submit_trader_claim(uuid,text,text,text,jsonb)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.submit_trader_claim_v2(
  uuid,text,text,text,timestamptz,timestamptz,text,text
) OWNER TO hostile_claim_admin;
ALTER FUNCTION public.reject_trader_claim_v2(uuid,uuid,text)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.cancel_trader_claim_v2(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.activate_trader_claim(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.activate_trader_claim_v2(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.set_primary_linked_trader(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.set_primary_linked_trader_v2(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.unlink_linked_trader(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.unlink_linked_trader_v2(uuid,uuid)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.arena_set_trader_claimed(text,text,uuid,boolean)
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.update_linked_trader_metadata_v1(
  uuid,uuid,boolean,text,boolean,integer
) OWNER TO hostile_claim_admin;
ALTER FUNCTION public.guard_trader_claim_activation_expiry()
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.guard_trader_authorization_v1_contract()
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.serialize_exchange_connection_v1_mutation()
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.guard_exchange_connection_authorization_v1_contract()
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.guard_user_profile_trader_identity_v1()
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.guard_arena_trader_claimed_meta_v1()
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.update_updated_at_column()
  OWNER TO hostile_claim_admin;
ALTER FUNCTION public.update_trader_authorizations_updated_at()
  OWNER TO hostile_claim_admin;
SET ROLE hostile_claim_admin;
CREATE OR REPLACE FUNCTION public.submit_trader_claim_v2(
  p_user_id uuid,
  p_trader_id text,
  p_source text,
  p_challenge_id text,
  p_challenge_issued_at timestamptz,
  p_verified_at timestamptz,
  p_message_digest text,
  p_signature_digest text
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  RAISE EXCEPTION 'hostile V2 submit body executed';
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.reject_trader_claim_v2(
  p_claim_id uuid,
  p_reviewer_id uuid,
  p_reject_reason text
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  RAISE EXCEPTION 'hostile V2 reject body executed';
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.cancel_trader_claim_v2(
  p_claim_id uuid,
  p_user_id uuid
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  RAISE EXCEPTION 'hostile V2 cancel body executed';
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.claim_cutover_guard_sentinel(label)
  VALUES ('claim');
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.guard_trader_authorization_v1_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.claim_cutover_guard_sentinel(label)
  VALUES ('authorization');
  RETURN NEW;
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.claim_cutover_guard_sentinel(label)
  VALUES ('shared timestamp');
  RETURN NEW;
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.update_trader_authorizations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.claim_cutover_guard_sentinel(label)
  VALUES ('authorization timestamp');
  RETURN NEW;
END;
$hostile$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM hostile_claim_admin;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column(),
  public.update_trader_authorizations_updated_at()
  TO inherited_profile_writer;
SQL

psql_cmd -q -f "$PHASE_B"

psql_cmd -q <<'SQL'
DO $phase_b_owner_replay_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid IN (
      'public.submit_trader_claim(uuid,text,text,text,jsonb)'::regprocedure,
      'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure,
      'public.reject_trader_claim_v2(uuid,uuid,text)'::regprocedure,
      'public.cancel_trader_claim_v2(uuid,uuid)'::regprocedure,
      'public.activate_trader_claim(uuid,uuid)'::regprocedure,
      'public.activate_trader_claim_v2(uuid,uuid)'::regprocedure,
      'public.set_primary_linked_trader(uuid,uuid)'::regprocedure,
      'public.set_primary_linked_trader_v2(uuid,uuid)'::regprocedure,
      'public.unlink_linked_trader(uuid,uuid)'::regprocedure,
      'public.unlink_linked_trader_v2(uuid,uuid)'::regprocedure,
      'public.arena_set_trader_claimed(text,text,uuid,boolean)'::regprocedure,
      'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)'::regprocedure,
      'public.guard_trader_claim_activation_expiry()'::regprocedure,
      'public.guard_trader_authorization_v1_contract()'::regprocedure,
      'public.serialize_exchange_connection_v1_mutation()'::regprocedure,
      'public.guard_exchange_connection_authorization_v1_contract()'::regprocedure,
      'public.guard_user_profile_trader_identity_v1()'::regprocedure,
      'public.guard_arena_trader_claimed_meta_v1()'::regprocedure,
      'public.update_updated_at_column()'::regprocedure,
      'public.update_trader_authorizations_updated_at()'::regprocedure
    )
      AND procedure_row.proowner IS DISTINCT FROM (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = 'public.trader_claims'::regclass
      )
  ) OR EXISTS (
    WITH expected(signature, source_sha256) AS (
      VALUES
        (
          'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::text,
          '2316424a0fdd0fb0ea26d7a1b31dd8686353c30f5dbfb6d311ca24f5d57c19c4'::text
        ),
        (
          'public.reject_trader_claim_v2(uuid,uuid,text)'::text,
          '0dfc5f8a70957120c39a260a6124b19cceeabf4895a94cbc760e44624b5e6dbf'::text
        ),
        (
          'public.cancel_trader_claim_v2(uuid,uuid)'::text,
          '6b1928167cf273cd7a873c109c2ee5446c36c9a53c304b6c99fd0d9e6bc28f69'::text
        )
    )
    SELECT 1
    FROM expected
    JOIN pg_catalog.pg_proc AS procedure_row
      ON procedure_row.oid = pg_catalog.to_regprocedure(expected.signature)
    WHERE pg_catalog.encode(
            extensions.digest(procedure_row.prosrc, 'sha256'),
            'hex'
          ) IS DISTINCT FROM expected.source_sha256
  ) THEN
    RAISE EXCEPTION 'custom Phase-B function owner or body survived replay';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.claim_cutover_guard_sentinel
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.trader_claims
       WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
         AND status = 'expired'
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
         AND status = 'revoked'
     ) THEN
    RAISE EXCEPTION
      'hostile cutoff guard executed before replay quarantine convergence';
  END IF;
END
$phase_b_owner_replay_proof$;
DELETE FROM public.trader_authorizations
WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
DELETE FROM public.trader_claims
WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
DROP TABLE public.claim_cutover_guard_sentinel;
SQL

echo 'Trader claim V2 two-phase cutoff PostgreSQL 17 proof passed'
