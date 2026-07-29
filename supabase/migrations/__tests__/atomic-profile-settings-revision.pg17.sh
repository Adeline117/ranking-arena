#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20260729068000. It owns an isolated
# temporary cluster and never connects to a developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729068000_atomic_profile_settings_revision.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-profile-settings-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55491
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

CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  handle text NOT NULL,
  bio text,
  avatar_url text,
  cover_url text,
  show_followers boolean NOT NULL DEFAULT true,
  show_following boolean NOT NULL DEFAULT true,
  dm_permission text NOT NULL DEFAULT 'all',
  show_pro_badge boolean NOT NULL DEFAULT true,
  settings_version integer,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_profile_select
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (id = (SELECT auth.uid()));
CREATE POLICY own_profile_update
  ON public.user_profiles
  FOR UPDATE
  TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

GRANT SELECT ON public.user_profiles TO authenticated;
GRANT UPDATE (
  handle,
  bio,
  avatar_url,
  cover_url,
  show_followers,
  show_following,
  dm_permission,
  show_pro_badge,
  settings_version
) ON public.user_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.user_profiles
  TO service_role;

INSERT INTO public.user_profiles (
  id,
  handle,
  bio,
  settings_version,
  is_banned,
  banned_at
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'alpha',
    'original',
    NULL,
    false,
    NULL
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'bravo',
    'negative revision',
    -4,
    false,
    NULL
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'blocked',
    'blocked profile',
    0,
    true,
    NULL
  );
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE settings_version IS NULL
          OR settings_version < 0
     )
     OR (
       SELECT count(*)
       FROM public.user_profiles
       WHERE settings_version = 0
     ) <> 3 THEN
    RAISE EXCEPTION 'historical profile revisions were not normalized';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.update_own_profile_settings(integer,text,text,text,text,boolean,boolean,text,boolean)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.update_own_profile_settings(integer,text,text,text,text,boolean,boolean,text,boolean)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.update_own_profile_settings(integer,text,text,text,text,boolean,boolean,text,boolean)',
       'EXECUTE'
     )
     OR has_column_privilege(
       'authenticated',
       'public.user_profiles',
       'settings_version',
       'UPDATE'
     ) THEN
    RAISE EXCEPTION 'profile revision privilege boundary failed';
  END IF;
END
$proof$;

SET ROLE anon;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.update_own_profile_settings(
      0,
      NULL,
      'forged',
      NULL,
      NULL,
      true,
      true,
      'all',
      true
    );
    RAISE EXCEPTION 'anonymous profile CAS unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $proof$
DECLARE
  v_result record;
BEGIN
  SELECT *
  INTO STRICT v_result
  FROM public.update_own_profile_settings(
    0,
    NULL,
    'first committed bio',
    NULL,
    NULL,
    false,
    true,
    'mutual',
    false
  );

  IF v_result.profile_id
       <> '11111111-1111-4111-8111-111111111111'::uuid
     OR v_result.settings_version <> 1 THEN
    RAISE EXCEPTION 'first profile CAS returned an invalid acknowledgement: %',
      v_result;
  END IF;

  BEGIN
    PERFORM public.update_own_profile_settings(
      0,
      NULL,
      'stale overwrite',
      NULL,
      NULL,
      true,
      true,
      'all',
      true
    );
    RAISE EXCEPTION 'stale profile CAS unexpectedly succeeded';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  IF NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND bio = 'first committed bio'
         AND settings_version = 1
         AND NOT show_followers
         AND show_following
         AND dm_permission = 'mutual'
         AND NOT show_pro_badge
     ) THEN
    RAISE EXCEPTION 'stale profile CAS changed the committed row';
  END IF;

  SELECT *
  INTO STRICT v_result
  FROM public.update_own_profile_settings(
    1,
    'alpha-renamed',
    'second committed bio',
    NULL,
    NULL,
    false,
    true,
    'mutual',
    false
  );

  IF v_result.settings_version <> 2 THEN
    RAISE EXCEPTION 'handle profile CAS did not advance the revision';
  END IF;

  SELECT *
  INTO STRICT v_result
  FROM public.update_own_profile_settings(
    2,
    NULL,
    'second committed bio',
    NULL,
    NULL,
    false,
    true,
    'mutual',
    false
  );

  IF v_result.settings_version <> 2 THEN
    RAISE EXCEPTION 'no-op profile CAS advanced the revision';
  END IF;

  BEGIN
    UPDATE public.user_profiles
    SET settings_version = 99
    WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'authenticated revision forgery unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE service_role;
UPDATE public.user_profiles
SET avatar_url = 'https://cdn.example.com/new-avatar.jpg'
WHERE id = '11111111-1111-4111-8111-111111111111';
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND settings_version = 3
         AND avatar_url = 'https://cdn.example.com/new-avatar.jpg'
     ) THEN
    RAISE EXCEPTION 'an external profile writer did not invalidate stale forms';
  END IF;
END
$proof$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $proof$
BEGIN
  BEGIN
    PERFORM public.update_own_profile_settings(
      2,
      NULL,
      'would lose the new avatar',
      NULL,
      NULL,
      false,
      true,
      'mutual',
      false
    );
    RAISE EXCEPTION 'external-writer stale CAS unexpectedly succeeded';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
END
$proof$;

SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
DO $proof$
BEGIN
  BEGIN
    PERFORM public.update_own_profile_settings(
      0,
      NULL,
      'missing',
      NULL,
      NULL,
      true,
      true,
      'all',
      true
    );
    RAISE EXCEPTION 'missing profile CAS unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
END
$proof$;

SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
DO $proof$
BEGIN
  BEGIN
    PERFORM public.update_own_profile_settings(
      0,
      NULL,
      'blocked overwrite',
      NULL,
      NULL,
      true,
      true,
      'all',
      true
    );
    RAISE EXCEPTION 'banned profile CAS unexpectedly succeeded';
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
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND bio = 'second committed bio'
         AND avatar_url = 'https://cdn.example.com/new-avatar.jpg'
         AND settings_version = 3
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '33333333-3333-4333-8333-333333333333'
         AND bio = 'blocked profile'
         AND settings_version = 0
     ) THEN
    RAISE EXCEPTION 'profile CAS failure paths changed persisted data';
  END IF;
END
$proof$;
SQL

echo "atomic profile settings revision PostgreSQL 17 proof passed"
