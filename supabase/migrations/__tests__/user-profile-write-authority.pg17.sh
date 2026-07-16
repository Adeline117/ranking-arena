#!/usr/bin/env bash

# PostgreSQL 17 proof for the user_profiles write-authority boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716178000_user_profile_write_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/user-profile-write-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55578
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

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >"$TMP_ROOT/failure.log" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

expect_migration_failure() {
  local needle="$1"
  local label="$2"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing migration failure evidence: $needle" >&2
    return 1
  fi
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
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE hostile_owner NOLOGIN;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO PUBLIC, anon, authenticated, service_role;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  handle text,
  bio text,
  avatar_url text,
  cover_url text,
  market_pairs jsonb,
  notify_follow boolean,
  notify_like boolean,
  notify_comment boolean,
  notify_mention boolean,
  notify_message boolean,
  notify_trader_events boolean NOT NULL DEFAULT true,
  show_followers boolean,
  show_following boolean,
  dm_permission text,
  email_digest text,
  settings_version integer,
  show_pro_badge boolean,
  last_seen_at timestamptz,
  is_online boolean,
  interests jsonb,
  onboarding_completed boolean,
  search_history jsonb,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz,
  weight integer DEFAULT 0,
  role text DEFAULT 'user',
  subscription_tier text DEFAULT 'free',
  is_pro boolean DEFAULT false,
  is_verified boolean DEFAULT false,
  is_verified_trader boolean DEFAULT false,
  follower_count integer DEFAULT 0,
  following_count integer DEFAULT 0,
  reputation_score integer DEFAULT 0,
  stripe_customer_id text,
  wallet_address text,
  updated_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

INSERT INTO public.user_profiles (id, handle) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Alpha'),
  ('22222222-2222-4222-8222-222222222222', 'Beta');

CREATE FUNCTION public.calculate_user_weight(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_weight integer;
BEGIN
  SELECT pg_catalog.char_length(COALESCE(profile.handle, ''))
      + pg_catalog.char_length(COALESCE(profile.bio, ''))
  INTO v_weight
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  UPDATE public.user_profiles
  SET weight = COALESCE(v_weight, 0)
  WHERE id = p_user_id;
  RETURN COALESCE(v_weight, 0);
END
$function$;

CREATE FUNCTION public.trigger_update_user_weight()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.handle IS DISTINCT FROM NEW.handle
    OR OLD.bio IS DISTINCT FROM NEW.bio
    OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
    OR OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier
  THEN
    NEW.weight := public.calculate_user_weight(NEW.id);
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.trigger_update_weight_on_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.calculate_user_weight(COALESCE(NEW.id, OLD.id));
  RETURN COALESCE(NEW, OLD);
END
$function$;

CREATE FUNCTION public.sync_author_handle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

CREATE TRIGGER trigger_auto_update_user_weight
BEFORE INSERT OR UPDATE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.trigger_update_user_weight();
CREATE TRIGGER trg_sync_author_handle
AFTER UPDATE OF handle ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_author_handle();

-- Reproduce Supabase's historical grants plus the overlapping permissive
-- policies.  The weak policy makes the broader policy irrelevant for UPDATE.
GRANT ALL PRIVILEGES ON TABLE public.user_profiles
  TO PUBLIC, anon, authenticated, service_role;
GRANT UPDATE (role, subscription_tier, is_pro, follower_count, wallet_address)
  ON TABLE public.user_profiles TO PUBLIC, anon, authenticated;

CREATE POLICY user_profiles_public_read
  ON public.user_profiles FOR SELECT TO public USING (true);
CREATE POLICY "Users can insert their own profile"
  ON public.user_profiles FOR INSERT TO public
  WITH CHECK ((SELECT auth.uid()) = id);
CREATE POLICY "Users can delete their own profile"
  ON public.user_profiles FOR DELETE TO public
  USING ((SELECT auth.uid()) = id);
CREATE POLICY "Users can update own profile (restricted columns)"
  ON public.user_profiles FOR UPDATE TO public
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);
CREATE POLICY "Users can update own profile (restricted)"
  ON public.user_profiles FOR UPDATE TO public
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id AND NOT COALESCE(is_pro, false));
CREATE POLICY "Service role can update user profiles"
  ON public.user_profiles FOR UPDATE TO public
  USING (true) WITH CHECK (true);
CREATE POLICY manual_profile_backdoor
  ON public.user_profiles FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
SQL

# Prove the fixture contains the real OR-policy escalation before hardening.
psql_cmd -Atqc \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET is_pro = true WHERE id = '11111111-1111-4111-8111-111111111111'" >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT is_pro FROM public.user_profiles WHERE id = '11111111-1111-4111-8111-111111111111'")" != "t" ]]; then
  echo "Vulnerable fixture did not reproduce protected-column escalation" >&2
  exit 1
fi
psql_cmd -Atqc \
  "UPDATE public.user_profiles SET is_pro = false WHERE id = '11111111-1111-4111-8111-111111111111'" >/dev/null

# Preflight failures must leave the vulnerable authority unchanged.
psql_cmd -c 'ALTER TABLE public.user_profiles OWNER TO hostile_owner' >/dev/null
expect_migration_failure \
  'public.user_profiles must be an ordinary postgres-owned table' \
  'owner-drift'
psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.user_profiles', 'INSERT,UPDATE,DELETE'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'manual_profile_backdoor'
  ) THEN
    RAISE EXCEPTION 'owner preflight failure partially changed profile authority';
  END IF;
END
$rollback_proof$;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles
  RENAME COLUMN notify_trader_events TO notify_trader_events_drift;
SQL
expect_migration_failure \
  'public.user_profiles write-authority columns are incompatible' \
  'column-drift'
psql_cmd -c \
  'ALTER TABLE public.user_profiles RENAME COLUMN notify_trader_events_drift TO notify_trader_events' \
  >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $authority_proof$
DECLARE
  v_authenticated oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  );
  v_service oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_authenticated_safe_update'
      AND policy.polroles = ARRAY[v_authenticated]::oid[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_service_mutation'
      AND policy.polroles = ARRAY[v_service]::oid[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_public_read'
      AND policy.polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'profile policy convergence proof failed';
  END IF;
END
$authority_proof$;
SQL

# Safe self-service columns remain writable and trusted weight side effects run.
psql_cmd -Atqc \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET bio = 'hello', show_followers = true, onboarding_completed = true WHERE id = '11111111-1111-4111-8111-111111111111'" \
  >/dev/null
if [[ "$(psql_cmd -Atqc "SELECT bio || ':' || weight::text FROM public.user_profiles WHERE id = '11111111-1111-4111-8111-111111111111'")" != "hello:10" ]]; then
  echo "Safe profile update or trusted weight side effect failed" >&2
  exit 1
fi

for protected_column in \
  role subscription_tier is_pro is_verified is_verified_trader \
  follower_count following_count reputation_score stripe_customer_id \
  wallet_address weight id
do
  case "$protected_column" in
    role) value="'admin'" ;;
    subscription_tier) value="'pro'" ;;
    stripe_customer_id) value="'cus_forged'" ;;
    wallet_address) value="'0x0000000000000000000000000000000000000000'" ;;
    id) value="'33333333-3333-4333-8333-333333333333'" ;;
    is_pro|is_verified|is_verified_trader) value="true" ;;
    *) value="999" ;;
  esac
  expect_failure \
    "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET $protected_column = $value WHERE id = '11111111-1111-4111-8111-111111111111'" \
    "authenticated protected profile update: $protected_column"
done

expect_failure \
  "SET ROLE anon; UPDATE public.user_profiles SET bio = 'anon' WHERE id = '11111111-1111-4111-8111-111111111111'" \
  'anonymous profile update'
expect_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333'; INSERT INTO public.user_profiles (id, handle, role) VALUES ('33333333-3333-4333-8333-333333333333', 'Forged', 'admin')" \
  'authenticated profile provisioning'
expect_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; DELETE FROM public.user_profiles WHERE id = '11111111-1111-4111-8111-111111111111'" \
  'authenticated profile delete'
expect_failure \
  "SET ROLE authenticated; SELECT public.calculate_user_weight('11111111-1111-4111-8111-111111111111')" \
  'authenticated direct weight recalculation'
expect_failure \
  'SET ROLE authenticated; CREATE TABLE public.profile_shadow (id integer)' \
  'authenticated public schema DDL'

OTHER_UPDATE="$(psql_cmd -Atqc \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET bio = 'stolen' WHERE id = '22222222-2222-4222-8222-222222222222' RETURNING id")"
if [[ -n "$OTHER_UPDATE" ]]; then
  echo "Authenticated user updated another profile" >&2
  exit 1
fi

# Deleted/currently banned rows are frozen; an expired boolean-only ban is not.
psql_cmd -Atqc \
  "SET ROLE service_role; UPDATE public.user_profiles SET banned_at = pg_catalog.clock_timestamp() WHERE id = '11111111-1111-4111-8111-111111111111'" >/dev/null
BANNED_UPDATE="$(psql_cmd -Atqc \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET bio = 'banned' WHERE id = '11111111-1111-4111-8111-111111111111' RETURNING id")"
if [[ -n "$BANNED_UPDATE" ]]; then
  echo "Banned profile remained self-writable" >&2
  exit 1
fi
psql_cmd -Atqc \
  "SET ROLE service_role; UPDATE public.user_profiles SET banned_at = NULL, is_banned = true, ban_expires_at = pg_catalog.clock_timestamp() - interval '1 second' WHERE id = '11111111-1111-4111-8111-111111111111'" >/dev/null
EXPIRED_UPDATE="$(psql_cmd -Atqc \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET bio = 'expired-ok' WHERE id = '11111111-1111-4111-8111-111111111111' RETURNING id")"
if [[ "$EXPIRED_UPDATE" != "11111111-1111-4111-8111-111111111111" ]]; then
  echo "Expired profile ban incorrectly blocked safe update" >&2
  exit 1
fi

# service_role retains protected DML without depending on BYPASSRLS.
psql_cmd -Atqc \
  "SET ROLE service_role; UPDATE public.user_profiles SET role = 'admin', is_pro = true WHERE id = '22222222-2222-4222-8222-222222222222'; INSERT INTO public.user_profiles (id, handle) VALUES ('44444444-4444-4444-8444-444444444444', 'Service'); DELETE FROM public.user_profiles WHERE id = '44444444-4444-4444-8444-444444444444'" \
  >/dev/null

# ACCESS EXCLUSIVE replay waits for an in-flight profile writer, then converges.
psql_cmd >"$TMP_ROOT/concurrency-holder.log" 2>&1 <<'SQL' &
BEGIN;
LOCK TABLE public.user_profiles IN ROW EXCLUSIVE MODE;
SELECT pg_catalog.pg_sleep(1.5) /* profile-authority-concurrency-holder */;
COMMIT;
SQL
HOLDER_PID=$!
for _ in {1..40}; do
  if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE query LIKE '%profile-authority-concurrency-holder%' AND state = 'active'")" == "1" ]]; then
    break
  fi
  sleep 0.05
done
psql_cmd -f "$MIGRATION" >/dev/null
wait "$HOLDER_PID"

# Unknown grants, columns, policies, trigger rewrites and function ACL drift are
# all removed by replay while the newly-added column stays protected by default.
psql_cmd <<'SQL'
ALTER TABLE public.user_profiles ADD COLUMN manual_rank integer DEFAULT 0;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.user_profiles TO PUBLIC, anon, authenticated;
GRANT INSERT (manual_rank), UPDATE (manual_rank), REFERENCES (manual_rank)
  ON TABLE public.user_profiles TO PUBLIC, anon, authenticated;
CREATE POLICY replay_profile_backdoor
  ON public.user_profiles FOR ALL TO public
  USING (true) WITH CHECK (true);
ALTER FUNCTION public.calculate_user_weight(uuid) SECURITY INVOKER;
GRANT EXECUTE ON FUNCTION public.calculate_user_weight(uuid) TO authenticated;
DROP TRIGGER trigger_auto_update_user_weight ON public.user_profiles;
CREATE TRIGGER trigger_auto_update_user_weight
BEFORE UPDATE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.trigger_update_user_weight();
SQL

psql_cmd -f "$MIGRATION" >/dev/null
expect_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; UPDATE public.user_profiles SET manual_rank = 999 WHERE id = '11111111-1111-4111-8111-111111111111'" \
  'replay-added protected column update'

psql_cmd <<'SQL'
DO $replay_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'replay_profile_backdoor'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_profiles',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_column_privilege(
    'authenticated', 'public.user_profiles', 'manual_rank', 'UPDATE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', 'public.calculate_user_weight(uuid)', 'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'trigger_auto_update_user_weight'
      AND trigger_row.tgfoid =
        'public.trigger_update_user_weight_after()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 17
  ) THEN
    RAISE EXCEPTION 'profile authority replay did not remove drift';
  END IF;
END
$replay_proof$;
SQL

echo "User profile write authority PostgreSQL 17 proof passed"
