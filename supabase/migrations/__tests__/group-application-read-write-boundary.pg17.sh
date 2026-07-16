#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the group-application API-only boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ATOMIC_MIGRATION="$ROOT_DIR/supabase/migrations/20260716111600_atomic_group_application_review.sql"
ACL_MIGRATION="$ROOT_DIR/supabase/migrations/20260716111700_group_application_read_write_boundary.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
for migration in "$ATOMIC_MIGRATION" "$ACL_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Group-application migration is missing: $migration" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-application-acl-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55450
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
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

PSQL=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -d postgres
)

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO PUBLIC, anon, authenticated, service_role;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  role text,
  subscription_tier text NOT NULL DEFAULT 'free',
  pro_expires_at timestamptz
);

CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tier text,
  plan text,
  status text NOT NULL,
  current_period_end timestamptz
);

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  slug text,
  created_by uuid NOT NULL,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  is_premium_only boolean NOT NULL DEFAULT false,
  member_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX groups_name_lower_unique
  ON public.groups (pg_catalog.lower(name));
CREATE UNIQUE INDEX groups_slug_key
  ON public.groups (slug);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.group_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL,
  name text NOT NULL,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  is_premium_only boolean DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  group_id uuid REFERENCES public.groups(id),
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.group_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.group_applications ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.group_applications TO anon, authenticated, service_role;
GRANT ALL ON public.user_profiles, public.groups, public.group_members,
  public.group_audit_log, public.subscriptions TO service_role;

-- Reproduce the legacy browser-authorized shape. The INSERT policy binds only
-- applicant_id and therefore admits forged review state before the lockdown.
CREATE POLICY legacy_applicant_insert
  ON public.group_applications
  FOR INSERT
  TO authenticated
  WITH CHECK (applicant_id = (SELECT auth.uid()));
CREATE POLICY legacy_applicant_read
  ON public.group_applications
  FOR SELECT
  TO authenticated
  USING (applicant_id = (SELECT auth.uid()));
CREATE POLICY legacy_admin_update
  ON public.group_applications
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
CREATE POLICY legacy_admin_delete
  ON public.group_applications
  FOR DELETE
  TO authenticated
  USING (true);

INSERT INTO public.user_profiles (id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', 'member'),
  ('22222222-2222-4222-8222-222222222222', 'member'),
  ('33333333-3333-4333-8333-333333333333', 'admin'),
  ('44444444-4444-4444-8444-444444444444', 'member'),
  ('55555555-5555-4555-8555-555555555555', 'member'),
  ('66666666-6666-4666-8666-666666666666', 'member');

INSERT INTO public.group_applications (
  id,
  applicant_id,
  name,
  status,
  reject_reason,
  reviewed_at,
  reviewed_by
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Legacy rejected application',
  'rejected',
  'private reviewer context',
  pg_catalog.clock_timestamp(),
  '33333333-3333-4333-8333-333333333333'
);
SQL

"${PSQL[@]}" -f "$ATOMIC_MIGRATION" >"$LOG_DIR/atomic.log"
"${PSQL[@]}" -f "$ACL_MIGRATION" >"$LOG_DIR/first-replay.log"
"${PSQL[@]}" -f "$ACL_MIGRATION" >"$LOG_DIR/second-replay.log"

"${PSQL[@]}" <<'SQL'
CREATE OR REPLACE FUNCTION public.expect_denied(p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  EXECUTE p_statement;
  RAISE EXCEPTION 'statement unexpectedly succeeded: %', p_statement;
EXCEPTION
  WHEN insufficient_privilege OR check_violation OR unique_violation
    OR not_null_violation OR foreign_key_violation
  THEN
    RETURN;
END
$function$;
GRANT EXECUTE ON FUNCTION public.expect_denied(text)
  TO anon, authenticated, service_role;

SET ROLE anon;
SELECT public.expect_denied($statement$
  SELECT id FROM public.group_applications
$statement$);
SELECT public.expect_denied($statement$
  INSERT INTO public.group_applications (applicant_id, name)
  VALUES ('11111111-1111-4111-8111-111111111111', 'anonymous forgery')
$statement$);
RESET ROLE;

SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  false
);
SELECT public.expect_denied($statement$
  SELECT id, name, status, reject_reason, group_id, created_at
  FROM public.group_applications
  WHERE applicant_id = '11111111-1111-4111-8111-111111111111'
$statement$);
SELECT public.expect_denied($statement$
  SELECT id
  FROM public.group_applications
  WHERE reviewed_by = '33333333-3333-4333-8333-333333333333'
  ORDER BY reviewed_at
$statement$);
SELECT public.expect_denied($statement$
  INSERT INTO public.group_applications (
    applicant_id,
    name,
    status,
    reject_reason,
    reviewed_at,
    reviewed_by,
    group_id
  ) VALUES (
    '11111111-1111-4111-8111-111111111111',
    'forged approved group',
    'approved',
    'forged',
    pg_catalog.clock_timestamp(),
    '33333333-3333-4333-8333-333333333333',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  )
$statement$);
SELECT public.expect_denied($statement$
  UPDATE public.group_applications
  SET status = 'approved',
      reviewed_by = '33333333-3333-4333-8333-333333333333'
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$statement$);
SELECT public.expect_denied($statement$
  DELETE FROM public.group_applications
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$statement$);

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  false
);
SELECT public.expect_denied($statement$
  SELECT id FROM public.group_applications
  WHERE applicant_id = '11111111-1111-4111-8111-111111111111'
$statement$);
RESET ROLE;

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $controlled_application_contract$
DECLARE
  result jsonb;
  unauthorized_application_id uuid;
  promo_application_id uuid;
  first_application_id uuid;
  second_application_id uuid;
  created_group_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.group_applications
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND reviewed_by = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'service lost internal application read access';
  END IF;

  result := public.submit_group_application_atomic(
    '55555555-5555-4555-8555-555555555555',
    'Unauthorized reviewer proof'
  );
  IF result ->> 'status' <> 'submitted' THEN
    RAISE EXCEPTION 'unauthorized-review fixture submission failed: %', result;
  END IF;
  unauthorized_application_id := (result ->> 'application_id')::uuid;

  result := public.review_group_application_atomic(
    '44444444-4444-4444-8444-444444444444',
    unauthorized_application_id,
    'approve',
    NULL
  );
  IF result ->> 'status' <> 'reviewer_unauthorized'
    OR NOT EXISTS (
      SELECT 1
      FROM public.group_applications
      WHERE id = unauthorized_application_id
        AND status = 'pending'
        AND reviewed_at IS NULL
        AND reviewed_by IS NULL
        AND group_id IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM public.groups
      WHERE created_by = '55555555-5555-4555-8555-555555555555'
    )
  THEN
    RAISE EXCEPTION 'active non-admin reviewer crossed the RPC boundary: %', result;
  END IF;

  result := public.submit_group_application_atomic(
    p_actor_id => '66666666-6666-4666-8666-666666666666',
    p_name => 'Promotion-controlled premium group',
    p_is_premium_only => true,
    p_promo_unlocked => false
  );
  IF result ->> 'status' <> 'pro_required' THEN
    RAISE EXCEPTION 'premium application ignored the closed promotion: %', result;
  END IF;

  result := public.submit_group_application_atomic(
    p_actor_id => '66666666-6666-4666-8666-666666666666',
    p_name => 'Promotion-controlled premium group',
    p_is_premium_only => true,
    p_promo_unlocked => true
  );
  IF result ->> 'status' <> 'submitted' THEN
    RAISE EXCEPTION 'server-controlled promotion was not honored: %', result;
  END IF;
  promo_application_id := (result ->> 'application_id')::uuid;

  result := public.review_group_application_atomic(
    p_reviewer_id => '33333333-3333-4333-8333-333333333333',
    p_application_id => promo_application_id,
    p_decision => 'approve',
    p_reject_reason => NULL,
    p_promo_unlocked => false
  );
  IF result ->> 'status' <> 'pro_required'
    OR NOT EXISTS (
      SELECT 1
      FROM public.group_applications
      WHERE id = promo_application_id
        AND status = 'pending'
        AND group_id IS NULL
    )
  THEN
    RAISE EXCEPTION 'premium review ignored the closed promotion: %', result;
  END IF;

  result := public.review_group_application_atomic(
    p_reviewer_id => '33333333-3333-4333-8333-333333333333',
    p_application_id => promo_application_id,
    p_decision => 'approve',
    p_reject_reason => NULL,
    p_promo_unlocked => true
  );
  IF result ->> 'status' <> 'approved' THEN
    RAISE EXCEPTION 'server-controlled promotion review failed: %', result;
  END IF;

  result := public.submit_group_application_atomic(
    '11111111-1111-4111-8111-111111111111',
    'Controlled rejection'
  );
  IF result ->> 'status' <> 'submitted' THEN
    RAISE EXCEPTION 'controlled submission failed: %', result;
  END IF;
  first_application_id := (result ->> 'application_id')::uuid;

  result := public.review_group_application_atomic(
    '33333333-3333-4333-8333-333333333333',
    first_application_id,
    'reject',
    'canonical reason'
  );
  IF result ->> 'status' <> 'rejected'
    OR NOT EXISTS (
      SELECT 1
      FROM public.group_applications
      WHERE id = first_application_id
        AND status = 'rejected'
        AND reject_reason = 'canonical reason'
        AND reviewed_by = '33333333-3333-4333-8333-333333333333'
    )
  THEN
    RAISE EXCEPTION 'controlled rejection failed: %', result;
  END IF;

  result := public.submit_group_application_atomic(
    '22222222-2222-4222-8222-222222222222',
    'Controlled approval'
  );
  IF result ->> 'status' <> 'submitted' THEN
    RAISE EXCEPTION 'approval fixture submission failed: %', result;
  END IF;
  second_application_id := (result ->> 'application_id')::uuid;

  result := public.review_group_application_atomic(
    '33333333-3333-4333-8333-333333333333',
    second_application_id,
    'approve',
    NULL
  );
  IF result ->> 'status' <> 'approved' THEN
    RAISE EXCEPTION 'controlled approval failed: %', result;
  END IF;
  created_group_id := (result ->> 'group_id')::uuid;

  IF NOT EXISTS (
    SELECT 1
    FROM public.group_applications AS application
    JOIN public.groups AS target_group ON target_group.id = application.group_id
    JOIN public.group_members AS owner_member
      ON owner_member.group_id = target_group.id
      AND owner_member.user_id = application.applicant_id
      AND owner_member.role = 'owner'::public.member_role
    JOIN public.group_audit_log AS audit
      ON audit.group_id = target_group.id
      AND audit.action = 'application_approved'
    WHERE application.id = second_application_id
      AND application.status = 'approved'
      AND target_group.id = created_group_id
  ) THEN
    RAISE EXCEPTION 'approval did not commit application/group/owner/audit atomically';
  END IF;
END
$controlled_application_contract$;

RESET ROLE;

DO $catalog_contract$
BEGIN
  IF pg_catalog.has_table_privilege(
    'anon',
    'public.group_applications',
    'SELECT,INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.group_applications',
    'SELECT,INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_any_column_privilege(
    'authenticated',
    'public.group_applications',
    'SELECT,INSERT,UPDATE,REFERENCES'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_applications'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'group-application catalog boundary drifted';
  END IF;
END
$catalog_contract$;
SQL

echo "group application read/write boundary PG17 integration proof passed"
