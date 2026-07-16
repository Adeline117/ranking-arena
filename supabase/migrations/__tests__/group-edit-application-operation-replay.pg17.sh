#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the atomic group-profile edit boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716170000_group_edit_application_operation_replay.sql"
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

TMP_ROOT="$(mktemp -d /tmp/group-edit-operation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55537
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres)

expect_failure() {
  local sql="$1"
  local label="$2"
  if "${PSQL[@]}" -Atqc "$sql" >/dev/null 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE ROLE hostile_role NOLOGIN;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
ALTER FUNCTION auth.uid() OWNER TO postgres;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role, hostile_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO PUBLIC;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE auth.users (id uuid PRIMARY KEY);
ALTER TABLE auth.users OWNER TO postgres;
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz,
  role text
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  is_premium_only boolean DEFAULT false,
  member_count integer DEFAULT 0,
  dissolved_at timestamptz,
  updated_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX groups_name_lower_unique
  ON public.groups (lower(name));
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_audit_log (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('system', 'message')),
  title text NOT NULL,
  message text NOT NULL,
  link text,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reference_id uuid,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.group_edit_applications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  rules_en text,
  is_premium_only boolean,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_audit_log OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;
ALTER TABLE public.group_edit_applications OWNER TO postgres;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_mutation ON public.groups FOR ALL TO service_role
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.groups TO service_role;
GRANT ALL ON public.group_edit_applications
  TO anon, authenticated, service_role, hostile_role;
GRANT ALL ON public.user_profiles, public.group_members,
  public.group_audit_log, public.notifications TO service_role;
ALTER TABLE public.group_edit_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_all ON public.group_edit_applications
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE FUNCTION public.handle_group_edit_approved()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$ BEGIN RETURN NEW; END $function$;
CREATE FUNCTION public.handle_group_edit_rejected()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$ BEGIN RETURN NEW; END $function$;
CREATE TRIGGER on_group_edit_approved
  AFTER UPDATE ON public.group_edit_applications
  FOR EACH ROW EXECUTE FUNCTION public.handle_group_edit_approved();
CREATE TRIGGER on_group_edit_rejected
  AFTER UPDATE ON public.group_edit_applications
  FOR EACH ROW EXECUTE FUNCTION public.handle_group_edit_rejected();

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
INSERT INTO public.user_profiles (id, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'member'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'member'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'member'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'admin');
INSERT INTO public.groups (id, name, created_by) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Legacy', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('20000000-0000-4000-8000-000000000002', 'Editable', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('30000000-0000-4000-8000-000000000003', 'Rejectable', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('40000000-0000-4000-8000-000000000004', 'Rollback', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
INSERT INTO public.group_members (group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('20000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('30000000-0000-4000-8000-000000000003', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'owner'),
  ('40000000-0000-4000-8000-000000000004', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'owner');

-- Two legacy pending rows prove deterministic reconciliation.
INSERT INTO public.group_edit_applications (
  id, group_id, applicant_id, name, status, created_at
) VALUES
  ('01000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Legacy One', 'pending', '2026-01-01Z'),
  ('01000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Legacy Two', 'pending', '2026-01-02Z'),
  ('03000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Rejected Proposal', 'pending', '2026-01-03Z');
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

"${PSQL[@]}" <<'SQL'
DO $proof$
BEGIN
  IF (SELECT count(*) FROM public.group_edit_applications
      WHERE group_id = '10000000-0000-4000-8000-000000000001'
        AND status = 'pending') <> 1
    OR (SELECT count(*) FROM public.group_audit_log
        WHERE action = 'edit_application_reconciled') <> 1
  THEN
    RAISE EXCEPTION 'duplicate pending reconciliation failed';
  END IF;
END
$proof$;
SQL

expect_failure \
  "SET ROLE service_role; INSERT INTO public.group_edit_applications (group_id,applicant_id,name,status) VALUES ('20000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Bypass','pending')" \
  "service_role direct application insert"
expect_failure \
  "SET ROLE service_role; UPDATE public.groups SET name='Bypass' WHERE id='20000000-0000-4000-8000-000000000002'" \
  "service_role direct profile update"

# Non-profile operational updates remain usable.
"${PSQL[@]}" -Atqc "SET ROLE service_role; UPDATE public.groups SET dissolved_at=clock_timestamp(), member_count=2 WHERE id='10000000-0000-4000-8000-000000000001'; RESET ROLE"

"${PSQL[@]}" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

CREATE TEMP TABLE submit_results AS
SELECT public.submit_group_edit_application_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000002',
  U&'Cafe\0301 Club',
  NULL,
  'Retail users',
  NULL,
  'https://example.com/a.png',
  '{"admin":{"zh":"管理员","en":"Admin"},"member":{"zh":"成员","en":"Member"}}'::jsonb,
  '[{"zh":"友善","en":"Kind"}]'::jsonb,
  'Be kind',
  false,
  '11111111-1111-4111-8111-111111111111'
) AS fresh;
ALTER TABLE submit_results ADD COLUMN replay jsonb;
UPDATE submit_results SET replay = public.submit_group_edit_application_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000002',
  U&'Cafe\0301 Club', NULL, 'Retail users', NULL,
  'https://example.com/a.png', '{"admin":{"zh":"管理员","en":"Admin"},"member":{"zh":"成员","en":"Member"}}'::jsonb,
  '[{"zh":"友善","en":"Kind"}]'::jsonb, 'Be kind', false,
  '11111111-1111-4111-8111-111111111111'
);

DO $proof$
DECLARE
  v_fresh jsonb := (SELECT fresh FROM submit_results);
  v_replay jsonb := (SELECT replay FROM submit_results);
BEGIN
  IF v_fresh ->> 'status' <> 'submitted'
    OR (v_fresh ->> 'applied')::boolean IS NOT TRUE
    OR (v_replay ->> 'applied')::boolean IS NOT FALSE
    OR (v_fresh - 'applied') IS DISTINCT FROM (v_replay - 'applied')
    OR v_fresh #>> '{application,name}' <> U&'Caf\00e9 Club'
    OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(v_fresh)) <> 4
    OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(v_fresh -> 'application')) <> 14
  THEN
    RAISE EXCEPTION 'submit fresh/replay/NFC contract failed: % / %', v_fresh, v_replay;
  END IF;
  IF public.submit_group_edit_application_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '20000000-0000-4000-8000-000000000002',
    'Different', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false,
    '11111111-1111-4111-8111-111111111111'
  ) IS DISTINCT FROM '{"status":"operation_conflict"}'::jsonb THEN
    RAISE EXCEPTION 'submit operation conflict is not strict';
  END IF;
END
$proof$;

CREATE TEMP TABLE approve_results AS
SELECT public.review_group_edit_application_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  (SELECT (fresh #>> '{application,id}')::uuid FROM submit_results),
  'approve', NULL,
  '22222222-2222-4222-8222-222222222222'
) AS fresh;
ALTER TABLE approve_results ADD COLUMN replay jsonb;
UPDATE approve_results SET replay = public.review_group_edit_application_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  (SELECT (fresh #>> '{application,id}')::uuid FROM submit_results),
  'approve', NULL,
  '22222222-2222-4222-8222-222222222222'
);

DO $proof$
DECLARE
  v_fresh jsonb := (SELECT fresh FROM approve_results);
  v_replay jsonb := (SELECT replay FROM approve_results);
BEGIN
  IF v_fresh ->> 'status' <> 'approved'
    OR (v_fresh ->> 'applied')::boolean IS NOT TRUE
    OR (v_replay ->> 'applied')::boolean IS NOT FALSE
    OR (v_fresh - 'applied') IS DISTINCT FROM (v_replay - 'applied')
    OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(v_fresh)) <> 8
    OR (SELECT name FROM public.groups
        WHERE id = '20000000-0000-4000-8000-000000000002') <> U&'Caf\00e9 Club'
    OR (SELECT count(*) FROM public.notifications
        WHERE reference_id = (v_fresh ->> 'application_id')::uuid) <> 1
  THEN
    RAISE EXCEPTION 'approve atomic/replay contract failed: % / %', v_fresh, v_replay;
  END IF;
END
$proof$;

CREATE TEMP TABLE reject_results AS
SELECT public.review_group_edit_application_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '03000000-0000-4000-8000-000000000003',
  'reject', U&'No\0301',
  '33333333-3333-4333-8333-333333333333'
) AS fresh;
ALTER TABLE reject_results ADD COLUMN replay jsonb;
UPDATE reject_results SET replay = public.review_group_edit_application_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '03000000-0000-4000-8000-000000000003',
  'reject', U&'No\0301',
  '33333333-3333-4333-8333-333333333333'
);

DO $proof$
DECLARE
  v_fresh jsonb := (SELECT fresh FROM reject_results);
  v_replay jsonb := (SELECT replay FROM reject_results);
BEGIN
  IF v_fresh ->> 'status' <> 'rejected'
    OR (v_fresh ->> 'applied')::boolean IS NOT TRUE
    OR (v_replay ->> 'applied')::boolean IS NOT FALSE
    OR (v_fresh - 'applied') IS DISTINCT FROM (v_replay - 'applied')
    OR v_fresh ->> 'reject_reason' <> U&'N\00f3'
    OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(v_fresh)) <> 9
    OR (SELECT count(*) FROM public.notifications
        WHERE reference_id = '03000000-0000-4000-8000-000000000003'
          AND actor_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> 1
    OR (SELECT name FROM public.groups
        WHERE id = '30000000-0000-4000-8000-000000000003') <> 'Rejectable'
  THEN
    RAISE EXCEPTION 'reject atomic/replay/NFC contract failed: % / %',
      v_fresh, v_replay;
  END IF;
  IF public.review_group_edit_application_atomic(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '03000000-0000-4000-8000-000000000003',
    'approve', NULL,
    '34343434-3434-4434-8434-343434343434'
  ) IS DISTINCT FROM '{"status":"already_processed"}'::jsonb THEN
    RAISE EXCEPTION 'opposite review did not lose atomically';
  END IF;
END
$proof$;
RESET ROLE;
SQL

# Successful replay survives group/application hard deletion.
"${PSQL[@]}" -Atqc "SET ROLE service_role; DELETE FROM public.groups WHERE id='20000000-0000-4000-8000-000000000002'; RESET ROLE"
"${PSQL[@]}" <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $proof$
DECLARE
  v_replay jsonb;
BEGIN
  SELECT public.review_group_edit_application_atomic(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (SELECT (result ->> 'application_id')::uuid
     FROM public.group_edit_application_operation_results
     WHERE operation_id = '22222222-2222-4222-8222-222222222222'),
    'approve', NULL,
    '22222222-2222-4222-8222-222222222222'
  ) INTO v_replay;
  IF (v_replay ->> 'applied')::boolean IS NOT FALSE
    OR v_replay ->> 'status' <> 'approved'
  THEN
    RAISE EXCEPTION 'durable replay after hard delete failed: %', v_replay;
  END IF;
END
$proof$;
SQL

# Notification failure must roll application/audit/ledger state back together.
"${PSQL[@]}" <<'SQL'
CREATE FUNCTION public.reject_edit_notification_for_test()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.reference_id = '90000000-0000-4000-8000-000000000009'::uuid THEN
    RAISE EXCEPTION 'forced notification failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER reject_edit_notification_for_test
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.reject_edit_notification_for_test();
INSERT INTO public.group_edit_applications (
  id, group_id, applicant_id, name, is_premium_only, status
) VALUES (
  '90000000-0000-4000-8000-000000000009',
  '40000000-0000-4000-8000-000000000004',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'Rollback Changed', false, 'pending'
);
SQL
expect_failure \
  "SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false); SELECT public.review_group_edit_application_atomic('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','90000000-0000-4000-8000-000000000009','reject','No','99999999-9999-4999-8999-999999999999')" \
  "notification rollback"
"${PSQL[@]}" <<'SQL'
DO $proof$
BEGIN
  IF (SELECT status FROM public.group_edit_applications
      WHERE id = '90000000-0000-4000-8000-000000000009') <> 'pending'
    OR EXISTS (
      SELECT 1 FROM public.group_edit_application_operation_results
      WHERE operation_id = '99999999-9999-4999-8999-999999999999'
    ) OR EXISTS (
      SELECT 1 FROM public.group_audit_log
      WHERE details ->> 'operation_id' = '99999999-9999-4999-8999-999999999999'
    )
  THEN
    RAISE EXCEPTION 'notification failure left partial state';
  END IF;
END
$proof$;
SQL

echo "group-edit application operation PostgreSQL 17 proof passed"
