#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for atomic moderation-queue actions, canonical
# report statuses, rollback, replay, ACLs, and concurrent idempotency.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716154731_atomic_report_moderation_queue.sql"
BASELINE_SUBMISSION_MIGRATION="$ROOT_DIR/supabase/migrations/20260716113800_private_report_evidence_storage.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/report-moderation-queue-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55631
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

wait_for_backend_state() {
  local query_fragment="$1"
  local wait_event_type="$2"
  local wait_event="${3:-}"
  local state_count

  for _attempt in {1..200}; do
    state_count="$(psql_cmd -Atc "
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE pid <> pg_catalog.pg_backend_pid()
        AND query LIKE '%${query_fragment}%'
        AND wait_event_type = '${wait_event_type}'
        AND (
          '${wait_event}' = ''
          OR wait_event = '${wait_event}'
        )
    ")"
    if ((state_count > 0)); then
      return 0
    fi
    sleep 0.01
  done

  echo "backend did not reach ${wait_event_type}/${wait_event}: ${query_fragment}" >&2
  psql_cmd -x -c "
    SELECT pid, state, wait_event_type, wait_event, query
    FROM pg_catalog.pg_stat_activity
    WHERE pid <> pg_catalog.pg_backend_pid()
  " >&2 || true
  return 1
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

CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text,
  banned_at timestamptz,
  banned_reason text,
  banned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ban_expires_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.comments(id),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY,
  user1_id uuid NOT NULL,
  user2_id uuid NOT NULL
);

CREATE TABLE public.content_reports (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  content_id text NOT NULL,
  reason text NOT NULL DEFAULT 'spam',
  description text,
  images text[] NOT NULL DEFAULT ARRAY['reports/test/evidence.png']::text[],
  status text NOT NULL DEFAULT 'pending',
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  action_taken text,
  created_at timestamptz DEFAULT pg_catalog.now(),
  CHECK (content_type IN ('post', 'comment', 'message', 'user')),
  CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misinformation', 'fraud', 'other')),
  CHECK (status IN ('pending', 'resolved', 'dismissed'))
);

CREATE UNIQUE INDEX uniq_content_reports_pending_reporter_content
  ON public.content_reports(reporter_id, content_type, content_id)
  WHERE status = 'pending';

CREATE TABLE public.report_evidence_uploads (
  evidence_ref text PRIMARY KEY,
  reporter_id uuid NOT NULL,
  object_name text NOT NULL UNIQUE,
  mime_type text NOT NULL DEFAULT 'image/png',
  status text NOT NULL DEFAULT 'reserved',
  report_id uuid REFERENCES public.content_reports(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE storage.objects (
  bucket_id text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (bucket_id, name)
);

CREATE TABLE public.user_strikes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issued_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  strike_type text NOT NULL CHECK (strike_type IN ('warning', 'mute', 'temp_ban', 'perm_ban')),
  expires_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.now()
);

CREATE TABLE public.admin_logs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.now()
);

CREATE FUNCTION public.content_report_evidence_refs_valid(
  p_reporter_id uuid,
  p_images text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_reporter_id IS NOT NULL
    AND p_images IS NOT NULL
    AND pg_catalog.cardinality(p_images) BETWEEN 1 AND 4
    AND pg_catalog.array_position(p_images, NULL) IS NULL
    AND (
      SELECT pg_catalog.count(DISTINCT evidence.ref)
      FROM pg_catalog.unnest(p_images) AS evidence(ref)
    ) = pg_catalog.cardinality(p_images)
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_images) AS evidence(ref)
      WHERE evidence.ref !~ (
        '^reports/' || pg_catalog.lower(p_reporter_id::text)
          || '/[0-9a-f]{16}\.(jpg|png|gif|webp|avif)$'
      )
    )
$function$;

ALTER FUNCTION public.content_report_evidence_refs_valid(uuid, text[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.content_report_evidence_refs_valid(uuid, text[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.content_report_evidence_refs_valid(uuid, text[])
  TO service_role;

CREATE FUNCTION public.lock_post_interaction_block_edges(
  p_post_id uuid,
  p_actor_id uuid,
  p_comment_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    WHERE post_row.id = p_post_id
      AND post_row.deleted_at IS NULL
  )
$$;

CREATE FUNCTION public.lock_actor_can_interact_with_post_locked_impl(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    WHERE post_row.id = p_post_id
      AND post_row.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF NOT public.lock_post_interaction_block_edges(
    p_post_id,
    p_actor_id,
    NULL::uuid
  ) THEN
    RETURN false;
  END IF;

  RETURN public.lock_actor_can_interact_with_post_locked_impl(
    p_post_id,
    p_actor_id
  );
END
$function$;

ALTER FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  OWNER TO postgres;

CREATE FUNCTION public.moderate_comment(
  p_comment_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (post_id uuid, affected_count integer, comment_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_id uuid;
  v_root_count integer := 0;
  v_reply_count integer := 0;
  v_deleted_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_action <> 'soft_delete' THEN
    RAISE EXCEPTION 'test helper accepts soft_delete only';
  END IF;

  SELECT comment_row.post_id
  INTO v_post_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM public.posts WHERE id = v_post_id FOR UPDATE;
  PERFORM 1 FROM public.comments WHERE id = p_comment_id FOR UPDATE;

  UPDATE public.comments AS target_comment
  SET deleted_at = v_deleted_at,
      deleted_by = p_actor_id,
      delete_reason = p_reason
  WHERE target_comment.id = p_comment_id
    AND target_comment.deleted_at IS NULL;
  GET DIAGNOSTICS v_root_count = ROW_COUNT;

  UPDATE public.comments AS reply
  SET deleted_at = v_deleted_at,
      deleted_by = p_actor_id,
      delete_reason = p_reason
  WHERE reply.parent_id = p_comment_id
    AND reply.deleted_at IS NULL;
  GET DIAGNOSTICS v_reply_count = ROW_COUNT;

  post_id := v_post_id;
  affected_count := v_root_count + v_reply_count;
  SELECT pg_catalog.count(*)::integer
  INTO comment_count
  FROM public.comments AS active_comment
  WHERE active_comment.post_id = v_post_id
    AND active_comment.deleted_at IS NULL;
  RETURN NEXT;
END
$$;

INSERT INTO auth.users(id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff');
SQL

# Exercise the real predecessor definition and its exact source fingerprint.
sed -n '1724,2061p' "$BASELINE_SUBMISSION_MIGRATION" | psql_cmd >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null
# Replaying the migration must preserve the exact function/ACL contract.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $acl_proof$
DECLARE
  v_function regprocedure :=
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'::regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'moderation RPC ACL is not service-only';
  END IF;
END
$acl_proof$;

SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
DO $role_guard_proof$
BEGIN
  PERFORM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '10000000-0000-4000-8000-000000000001',
    'approve'
  );
  RAISE EXCEPTION 'non-service claim unexpectedly crossed moderation RPC';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
END
$role_guard_proof$;

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

INSERT INTO public.user_profiles(id, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'user'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'user');

INSERT INTO public.posts(id, author_id) VALUES
  ('10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000003', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('10000000-0000-4000-8000-000000000004', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('10000000-0000-4000-8000-000000000005', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000006', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

INSERT INTO public.comments(
  id, post_id, user_id, parent_id, deleted_at, deleted_by, delete_reason
) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    NULL,
    '2026-07-10T00:00:00Z',
    NULL,
    'Auto-hidden: legacy weighted report score'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    NULL, NULL, NULL, NULL
  ),
  (
    '20000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000002',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '20000000-0000-4000-8000-000000000002',
    NULL, NULL, NULL
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000004',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    NULL, NULL, NULL, NULL
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000005',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    NULL, NULL, NULL, NULL
  );

INSERT INTO public.content_reports(id, reporter_id, content_type, content_id) VALUES
  ('30000000-0000-4000-8000-000000000001', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'comment', '20000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000002', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'comment', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000012', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'comment', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000003', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000003'),
  ('30000000-0000-4000-8000-000000000004', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'comment', '20000000-0000-4000-8000-000000000004'),
  ('30000000-0000-4000-8000-000000000005', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'comment', '20000000-0000-4000-8000-000000000005'),
  ('30000000-0000-4000-8000-000000000006', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000006');

DO $approve_proof$
DECLARE
  v_result record;
  v_legacy_deleted_at timestamptz;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'comment',
    '20000000-0000-4000-8000-000000000001',
    'approve'
  );
  IF NOT v_result.applied
     OR v_result.report_status <> 'dismissed'
     OR v_result.action_taken <> 'approved_content'
     OR v_result.report_count <> 1
     OR v_result.content_soft_deleted IS NOT TRUE
  THEN
    RAISE EXCEPTION 'approve acknowledgement is invalid: %', v_result;
  END IF;

  SELECT deleted_at INTO v_legacy_deleted_at
  FROM public.comments
  WHERE id = '20000000-0000-4000-8000-000000000001';
  IF v_legacy_deleted_at IS NULL THEN
    RAISE EXCEPTION 'approve restored a legacy auto-hidden comment';
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'comment',
    '20000000-0000-4000-8000-000000000001',
    'approve'
  );
  IF v_result.applied
     OR v_result.report_status <> 'dismissed'
     OR v_result.action_taken <> 'approved_content'
     OR v_result.report_count <> 1
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'approve replay evidence is invalid: %', v_result;
  END IF;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'comment',
      '20000000-0000-4000-8000-000000000001',
      'delete'
    );
    RAISE EXCEPTION 'approve-to-delete cross action was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
END
$approve_proof$;

DO $delete_proof$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'comment',
    '20000000-0000-4000-8000-000000000002',
    'delete'
  );
  IF NOT v_result.applied
     OR v_result.report_status <> 'resolved'
     OR v_result.action_taken <> 'content_deleted'
     OR v_result.report_count <> 2
     OR v_result.content_affected_count <> 2
  THEN
    RAISE EXCEPTION 'delete acknowledgement is invalid: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.comments
    WHERE id IN (
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000012'
    ) AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'delete did not soft-delete the comment tree';
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'comment',
    '20000000-0000-4000-8000-000000000002',
    'delete'
  );
  IF v_result.applied
     OR v_result.report_status <> 'resolved'
     OR v_result.action_taken <> 'content_deleted'
     OR v_result.report_count <> 2
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'delete replay evidence is invalid: %', v_result;
  END IF;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'comment',
      '20000000-0000-4000-8000-000000000002',
      'approve'
    );
    RAISE EXCEPTION 'delete-to-approve cross action was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
END
$delete_proof$;

DO $warn_proof$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '10000000-0000-4000-8000-000000000003',
    'warn'
  );
  IF NOT v_result.applied
     OR v_result.report_status <> 'resolved'
     OR v_result.strike_type <> 'warning'
     OR v_result.strike_id IS NULL
  THEN
    RAISE EXCEPTION 'warn acknowledgement is invalid: %', v_result;
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '10000000-0000-4000-8000-000000000003',
    'warn'
  );
  IF v_result.applied
     OR v_result.report_status <> 'resolved'
     OR v_result.action_taken <> 'user_warned'
     OR v_result.report_count <> 1
     OR v_result.content_affected_count <> 0
     OR v_result.strike_id IS NOT NULL
     OR v_result.strike_type IS NOT NULL
  THEN
    RAISE EXCEPTION 'warn replay repeated a sanction: %', v_result;
  END IF;
  IF (
    SELECT pg_catalog.count(*) FROM public.user_strikes
    WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ) <> 1 THEN
    RAISE EXCEPTION 'warn replay duplicated a strike';
  END IF;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '10000000-0000-4000-8000-000000000003',
      'ban'
    );
    RAISE EXCEPTION 'warn-to-ban cross action was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
END
$warn_proof$;

DO $ban_proof$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'comment',
    '20000000-0000-4000-8000-000000000004',
    'ban'
  );
  IF NOT v_result.applied
     OR v_result.report_status <> 'resolved'
     OR v_result.action_taken <> 'user_banned'
     OR v_result.content_soft_deleted IS NOT TRUE
  THEN
    RAISE EXCEPTION 'ban acknowledgement is invalid: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      AND banned_at IS NOT NULL
      AND banned_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND ban_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'ban did not update the bound content author';
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'comment',
    '20000000-0000-4000-8000-000000000004',
    'ban'
  );
  IF v_result.applied
     OR v_result.report_status <> 'resolved'
     OR v_result.action_taken <> 'user_banned'
     OR v_result.report_count <> 1
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'ban replay evidence is invalid: %', v_result;
  END IF;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'comment',
      '20000000-0000-4000-8000-000000000004',
      'warn'
    );
    RAISE EXCEPTION 'ban-to-warn cross action was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
END
$ban_proof$;

DO $unknown_target_is_not_a_replay_proof$
BEGIN
  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '10000000-0000-4000-8000-000000000099',
      'approve'
    );
    RAISE EXCEPTION 'unknown target was accepted as an idempotent replay';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN NULL;
  END;
END
$unknown_target_is_not_a_replay_proof$;

DO $canonical_status_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE status NOT IN ('pending', 'resolved', 'dismissed')
  ) OR EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE status <> 'pending' AND resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'moderation wrote a noncanonical/incomplete report status';
  END IF;
END
$canonical_status_proof$;

-- A delete acknowledgement distinguishes an existing row that was already
-- soft-deleted from a target that is physically absent. Neither case may claim
-- that this call mutated content.
INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id
) VALUES
  (
    '30000000-0000-4000-8000-000000000020',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'comment',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '30000000-0000-4000-8000-000000000021',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'post',
    '10000000-0000-4000-8000-000000000021'
  );

DO $already_absent_ack_proof$
DECLARE
  v_result record;
  v_original_deleted_at timestamptz;
BEGIN
  SELECT deleted_at
  INTO STRICT v_original_deleted_at
  FROM public.comments
  WHERE id = '20000000-0000-4000-8000-000000000001';

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'comment',
    '20000000-0000-4000-8000-000000000001',
    'delete'
  );

  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_already_absent'
     OR v_result.author_id IS DISTINCT FROM
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
     OR v_result.content_soft_deleted IS NOT TRUE
     OR v_result.content_affected_count <> 0
     OR (
       SELECT deleted_at
       FROM public.comments
       WHERE id = '20000000-0000-4000-8000-000000000001'
     ) IS DISTINCT FROM v_original_deleted_at
  THEN
    RAISE EXCEPTION
      'already-soft-deleted acknowledgement is invalid: %', v_result;
  END IF;

  -- This target has an older approved batch and a newer delete batch. The
  -- older match must never hide the latest conflicting action.
  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'comment',
      '20000000-0000-4000-8000-000000000001',
      'approve'
    );
    RAISE EXCEPTION 'older matching action hid a newer moderation conflict';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '10000000-0000-4000-8000-000000000021',
    'delete'
  );

  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_already_absent'
     OR v_result.author_id IS NOT NULL
     OR v_result.content_soft_deleted IS NOT NULL
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION
      'physically-missing acknowledgement is invalid: %', v_result;
  END IF;
END
$already_absent_ack_proof$;
SQL

# A failure after comment mutation but before report transition must roll the
# complete function statement back, including content and audit writes.
psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

CREATE FUNCTION public.fail_selected_report_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.content_id = '20000000-0000-4000-8000-000000000005' THEN
    RAISE EXCEPTION 'forced report transition failure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fail_selected_report_transition
BEFORE UPDATE ON public.content_reports
FOR EACH ROW EXECUTE FUNCTION public.fail_selected_report_transition();

DO $rollback_proof$
BEGIN
  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'comment',
      '20000000-0000-4000-8000-000000000005',
      'delete'
    );
    RAISE EXCEPTION 'forced transition failure did not abort moderation';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM public.comments
    WHERE id = '20000000-0000-4000-8000-000000000005'
      AND deleted_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000005'
      AND status = 'pending'
  ) OR EXISTS (
    SELECT 1 FROM public.admin_logs
    WHERE target_id = '20000000-0000-4000-8000-000000000005'
  ) THEN
    RAISE EXCEPTION 'failed report transition left partial moderation state';
  END IF;
END
$rollback_proof$;

DROP TRIGGER fail_selected_report_transition ON public.content_reports;
DROP FUNCTION public.fail_selected_report_transition();
SQL

# Hold the first transaction inside its audit insert so the second caller must
# wait on the target advisory/row lock. Exactly one may apply the pending batch.
psql_cmd <<'SQL'
CREATE FUNCTION public.pause_selected_moderation_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.target_id = '10000000-0000-4000-8000-000000000006' THEN
    PERFORM pg_catalog.pg_sleep(0.5);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pause_selected_moderation_audit
BEFORE INSERT ON public.admin_logs
FOR EACH ROW EXECUTE FUNCTION public.pause_selected_moderation_audit();
SQL

for worker in 1 2; do
  (
    psql_cmd -At <<'SQL' >"$TMP_ROOT/concurrent-$worker.log"
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT applied::text
FROM public.moderate_report_queue_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-000000000006',
  'approve'
);
SQL
  ) &
done
wait

if [[ "$(grep -hE '^(true|false)$' "$TMP_ROOT"/concurrent-*.log | sort | tr '\n' ' ')" != "false true " ]]; then
  echo "concurrent moderation calls did not produce one apply and one replay" >&2
  cat "$TMP_ROOT"/concurrent-*.log >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_selected_moderation_audit ON public.admin_logs;
DROP FUNCTION public.pause_selected_moderation_audit();

DO $concurrency_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000006'
      AND status = 'dismissed'
  ) OR (
    SELECT pg_catalog.count(*) FROM public.admin_logs
    WHERE target_id = '10000000-0000-4000-8000-000000000006'
      AND action = 'dismiss_reports'
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent moderation did not commit exactly one action';
  END IF;
END
$concurrency_proof$;
SQL

# Submission wins the target linearization point, pauses before its report
# insert, and moderation starts only after both submit advisories are visible.
# Moderation must wait, then include the newly committed report in its batch.
psql_cmd <<'SQL'
INSERT INTO public.user_profiles(id, role) VALUES
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'user');

INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000007',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );

INSERT INTO public.report_evidence_uploads(
  evidence_ref,
  reporter_id,
  object_name,
  status,
  expires_at
) VALUES (
  'reports/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/0123456789abcdef.png',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/0123456789abcdef.png',
  'uploaded',
  pg_catalog.clock_timestamp() + INTERVAL '1 hour'
);

INSERT INTO storage.objects(bucket_id, name) VALUES (
  'reports',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/0123456789abcdef.png'
);

CREATE FUNCTION public.pause_selected_report_submission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.content_id = '10000000-0000-4000-8000-000000000007' THEN
    PERFORM pg_catalog.pg_sleep(0.8);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pause_selected_report_submission
BEFORE INSERT ON public.content_reports
FOR EACH ROW EXECUTE FUNCTION public.pause_selected_report_submission();
SQL

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/submit-vs-moderation-submit.log"
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_content_report(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '10000000-0000-4000-8000-000000000007',
  'spam',
  'This report is long enough for the concurrency proof.',
  ARRAY[
    'reports/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/0123456789abcdef.png'
  ]::text[]
);
SQL
) &
submit_pid=$!

submit_locks_visible=false
for _attempt in {1..100}; do
  advisory_lock_count="$(psql_cmd -Atc \
    "SELECT pg_catalog.count(*) FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_catalog.pg_backend_pid()")"
  if ((advisory_lock_count >= 2)); then
    submit_locks_visible=true
    break
  fi
  sleep 0.02
done

if [[ "$submit_locks_visible" != "true" ]]; then
  echo "submission did not expose both advisory locks before timeout" >&2
  wait "$submit_pid" || true
  cat "$TMP_ROOT/submit-vs-moderation-submit.log" >&2
  exit 1
fi

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/submit-vs-moderation-action.log"
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT applied::text || '|' || report_count::text || '|' || report_status
FROM public.moderate_report_queue_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-000000000007',
  'approve'
);
SQL
) &
moderation_pid=$!

wait "$submit_pid"
wait "$moderation_pid"

if ! grep -q '"created": true' \
  "$TMP_ROOT/submit-vs-moderation-submit.log"; then
  echo "concurrent submission did not create its report" >&2
  cat "$TMP_ROOT/submit-vs-moderation-submit.log" >&2
  exit 1
fi

if ! grep -qx 'true|1|dismissed' \
  "$TMP_ROOT/submit-vs-moderation-action.log"; then
  echo "moderation missed the submission that linearized first" >&2
  cat "$TMP_ROOT/submit-vs-moderation-action.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_selected_report_submission ON public.content_reports;
DROP FUNCTION public.pause_selected_report_submission();

DO $submit_moderation_concurrency_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.content_reports
    WHERE content_type = 'post'
      AND content_id = '10000000-0000-4000-8000-000000000007'
      AND status = 'pending'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.content_reports
    WHERE reporter_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      AND content_type = 'post'
      AND content_id = '10000000-0000-4000-8000-000000000007'
      AND status = 'dismissed'
      AND resolved_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads
    WHERE evidence_ref =
      'reports/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/0123456789abcdef.png'
      AND status = 'claimed'
      AND report_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'submit/moderation concurrency left an unexpected pending/evidence state';
  END IF;
END
$submit_moderation_concurrency_proof$;
SQL

# Two targets owned by one author take distinct target locks but the same
# sanction lock. Starting from one strike, the pair must become warning + mute,
# never two warnings from the same stale strike count.
psql_cmd <<'SQL'
INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000008',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  (
    '10000000-0000-4000-8000-000000000009',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );

INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id
) VALUES
  (
    '30000000-0000-4000-8000-000000000008',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'post',
    '10000000-0000-4000-8000-000000000008'
  ),
  (
    '30000000-0000-4000-8000-000000000009',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'post',
    '10000000-0000-4000-8000-000000000009'
  );

INSERT INTO public.user_strikes(
  user_id,
  issued_by,
  reason,
  strike_type
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Seed strike for sanction serialization proof',
  'warning'
);

CREATE FUNCTION public.pause_selected_sanction_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' THEN
    PERFORM pg_catalog.pg_sleep(0.5);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pause_selected_sanction_insert
BEFORE INSERT ON public.user_strikes
FOR EACH ROW EXECUTE FUNCTION public.pause_selected_sanction_insert();
SQL

for target_suffix in 8 9; do
  (
    psql_cmd -At <<SQL >"$TMP_ROOT/concurrent-warn-$target_suffix.log"
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT strike_type
FROM public.moderate_report_queue_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-00000000000$target_suffix',
  'warn'
);
SQL
  ) &
done
wait

if [[ "$(grep -hE '^(warning|mute)$' \
  "$TMP_ROOT"/concurrent-warn-*.log | sort | tr '\n' ' ')" != \
  "mute warning " ]]; then
  echo "same-author warnings did not serialize escalation" >&2
  cat "$TMP_ROOT"/concurrent-warn-*.log >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_selected_sanction_insert ON public.user_strikes;
DROP FUNCTION public.pause_selected_sanction_insert();

DO $same_author_warn_concurrency_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_strikes
    WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM public.user_strikes
    WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      AND strike_type = 'warning'
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM public.user_strikes
    WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      AND strike_type = 'mute'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM public.content_reports
    WHERE content_id IN (
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000009'
    )
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION
      'same-author concurrent warnings committed a stale escalation result';
  END IF;
END
$same_author_warn_concurrency_proof$;
SQL

# Reporter deletion must follow auth parent -> profile/report/evidence children.
# First let submission hold the reporter auth parent while it creates and claims
# a report. The hard delete waits, then cascades both old and new reports and
# nulls both evidence links without a deadlock or half-claimed report.
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.user_profiles(id, role) VALUES
  ('11111111-1111-4111-8111-111111111111', 'user');
INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000030',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id,
  status,
  resolved_by,
  resolved_at,
  action_taken
) VALUES (
  '30000000-0000-4000-8000-000000000030',
  '11111111-1111-4111-8111-111111111111',
  'post',
  '10000000-0000-4000-8000-000000000001',
  'dismissed',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pg_catalog.clock_timestamp(),
  'seeded_for_auth_cascade_proof'
);
INSERT INTO public.report_evidence_uploads(
  evidence_ref,
  reporter_id,
  object_name,
  status,
  report_id,
  expires_at
) VALUES
  (
    'reports/11111111-1111-4111-8111-111111111111/1111111111111111.png',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/1111111111111111.png',
    'claimed',
    '30000000-0000-4000-8000-000000000030',
    pg_catalog.clock_timestamp() + INTERVAL '1 hour'
  ),
  (
    'reports/11111111-1111-4111-8111-111111111111/2222222222222222.png',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/2222222222222222.png',
    'uploaded',
    NULL,
    pg_catalog.clock_timestamp() + INTERVAL '1 hour'
  );
INSERT INTO storage.objects(bucket_id, name) VALUES
  (
    'reports',
    '11111111-1111-4111-8111-111111111111/1111111111111111.png'
  ),
  (
    'reports',
    '11111111-1111-4111-8111-111111111111/2222222222222222.png'
  );

CREATE FUNCTION public.pause_submit_before_report_insert_for_auth_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.reporter_id = '11111111-1111-4111-8111-111111111111'
     AND NEW.content_id = '10000000-0000-4000-8000-000000000030'
  THEN
    PERFORM pg_catalog.pg_sleep(1.2);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pause_submit_before_report_insert_for_auth_delete
BEFORE INSERT ON public.content_reports
FOR EACH ROW
EXECUTE FUNCTION public.pause_submit_before_report_insert_for_auth_delete();
SQL

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/submit-first-vs-reporter-delete-submit.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_content_report(
  '11111111-1111-4111-8111-111111111111',
  'post',
  '10000000-0000-4000-8000-000000000030',
  'spam',
  'Reporter deletion waits for this fully atomic submission.',
  ARRAY[
    'reports/11111111-1111-4111-8111-111111111111/2222222222222222.png'
  ]::text[]
);
SQL
) &
submit_first_pid=$!

wait_for_backend_state \
  '10000000-0000-4000-8000-000000000030' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/submit-first-vs-reporter-delete-delete.log" 2>&1
DELETE FROM auth.users
WHERE id = '11111111-1111-4111-8111-111111111111';
SQL
) &
reporter_delete_second_pid=$!

wait_for_backend_state \
  '11111111-1111-4111-8111-111111111111' 'Lock'
wait "$submit_first_pid"
wait "$reporter_delete_second_pid"

if ! grep -q '"created": true' \
  "$TMP_ROOT/submit-first-vs-reporter-delete-submit.log"; then
  echo "submit-first reporter deletion race did not create the report" >&2
  cat "$TMP_ROOT/submit-first-vs-reporter-delete-submit.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_submit_before_report_insert_for_auth_delete
  ON public.content_reports;
DROP FUNCTION public.pause_submit_before_report_insert_for_auth_delete();

DO $submit_first_reporter_delete_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '11111111-1111-4111-8111-111111111111'
  ) OR EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '11111111-1111-4111-8111-111111111111'
  ) OR EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE reporter_id = '11111111-1111-4111-8111-111111111111'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM public.report_evidence_uploads
    WHERE reporter_id = '11111111-1111-4111-8111-111111111111'
      AND status = 'claimed'
      AND report_id IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION
      'submit-first reporter deletion left an auth/report/evidence orphan';
  END IF;
END
$submit_first_reporter_delete_proof$;
SQL

# Reverse the order: auth deletion owns the reporter parent first and pauses in
# its profile cascade. Submission may observe the target, but must wait on the
# auth parent and fail closed before locking evidence or inserting a report.
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('22222222-2222-4222-8222-222222222222');
INSERT INTO public.user_profiles(id, role) VALUES
  ('22222222-2222-4222-8222-222222222222', 'user');
INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000031',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id,
  status,
  resolved_by,
  resolved_at,
  action_taken
) VALUES (
  '30000000-0000-4000-8000-000000000031',
  '22222222-2222-4222-8222-222222222222',
  'post',
  '10000000-0000-4000-8000-000000000001',
  'dismissed',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pg_catalog.clock_timestamp(),
  'seeded_for_reverse_auth_cascade_proof'
);
INSERT INTO public.report_evidence_uploads(
  evidence_ref,
  reporter_id,
  object_name,
  status,
  report_id,
  expires_at
) VALUES
  (
    'reports/22222222-2222-4222-8222-222222222222/3333333333333333.png',
    '22222222-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222/3333333333333333.png',
    'claimed',
    '30000000-0000-4000-8000-000000000031',
    pg_catalog.clock_timestamp() + INTERVAL '1 hour'
  ),
  (
    'reports/22222222-2222-4222-8222-222222222222/4444444444444444.png',
    '22222222-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222/4444444444444444.png',
    'uploaded',
    NULL,
    pg_catalog.clock_timestamp() + INTERVAL '1 hour'
  );
INSERT INTO storage.objects(bucket_id, name) VALUES
  (
    'reports',
    '22222222-2222-4222-8222-222222222222/3333333333333333.png'
  ),
  (
    'reports',
    '22222222-2222-4222-8222-222222222222/4444444444444444.png'
  );

CREATE FUNCTION public.pause_reporter_profile_auth_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.id = '22222222-2222-4222-8222-222222222222' THEN
    PERFORM pg_catalog.pg_sleep(1.2);
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER pause_reporter_profile_auth_cascade
BEFORE DELETE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.pause_reporter_profile_auth_cascade();
SQL

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/reporter-delete-first-delete.log" 2>&1
DELETE FROM auth.users
WHERE id = '22222222-2222-4222-8222-222222222222';
SQL
) &
reporter_delete_first_pid=$!

wait_for_backend_state \
  '22222222-2222-4222-8222-222222222222' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/reporter-delete-first-submit.log" 2>&1
\set VERBOSITY verbose
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_content_report(
  '22222222-2222-4222-8222-222222222222',
  'post',
  '10000000-0000-4000-8000-000000000031',
  'spam',
  'This submission must fail after the reporter identity is deleted.',
  ARRAY[
    'reports/22222222-2222-4222-8222-222222222222/4444444444444444.png'
  ]::text[]
);
SQL
) &
submit_second_pid=$!

wait_for_backend_state \
  '10000000-0000-4000-8000-000000000031' 'Lock'
wait "$reporter_delete_first_pid"
if wait "$submit_second_pid"; then
  echo "delete-first submission unexpectedly succeeded" >&2
  cat "$TMP_ROOT/reporter-delete-first-submit.log" >&2
  exit 1
fi

if ! grep -q '42501.*active reporter identity required' \
  "$TMP_ROOT/reporter-delete-first-submit.log"; then
  echo "delete-first submission did not fail with the exact auth guard" >&2
  cat "$TMP_ROOT/reporter-delete-first-submit.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_reporter_profile_auth_cascade ON public.user_profiles;
DROP FUNCTION public.pause_reporter_profile_auth_cascade();

DO $reporter_delete_first_submit_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '22222222-2222-4222-8222-222222222222'
  ) OR EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '22222222-2222-4222-8222-222222222222'
  ) OR EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE reporter_id = '22222222-2222-4222-8222-222222222222'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads
    WHERE evidence_ref =
      'reports/22222222-2222-4222-8222-222222222222/3333333333333333.png'
      AND status = 'claimed'
      AND report_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.report_evidence_uploads
    WHERE evidence_ref =
      'reports/22222222-2222-4222-8222-222222222222/4444444444444444.png'
      AND status = 'uploaded'
      AND report_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'reporter-delete-first race claimed evidence or left report children';
  END IF;
END
$reporter_delete_first_submit_proof$;
SQL

# Moderation-first author deletion: the RPC holds the discovered author auth
# parent before touching content/report children. The hard delete waits, then
# cascades the author profile/content only after the moderation transaction is
# complete; the resolved report and audit remain internally consistent.
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles(id, role) VALUES
  ('33333333-3333-4333-8333-333333333333', 'user');
INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000032',
    '33333333-3333-4333-8333-333333333333'
  );
INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id
) VALUES (
  '30000000-0000-4000-8000-000000000032',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '10000000-0000-4000-8000-000000000032'
);

CREATE FUNCTION public.pause_author_race_moderation_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.target_id = '10000000-0000-4000-8000-000000000032' THEN
    PERFORM pg_catalog.pg_sleep(1.2);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pause_author_race_moderation_audit
BEFORE INSERT ON public.admin_logs
FOR EACH ROW EXECUTE FUNCTION public.pause_author_race_moderation_audit();
SQL

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/moderation-first-vs-author-delete-action.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT applied::text || '|' || action_taken || '|' ||
  content_affected_count::text
FROM public.moderate_report_queue_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-000000000032',
  'delete'
);
SQL
) &
moderation_first_pid=$!

wait_for_backend_state \
  '10000000-0000-4000-8000-000000000032' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/moderation-first-vs-author-delete-delete.log" 2>&1
DELETE FROM auth.users
WHERE id = '33333333-3333-4333-8333-333333333333';
SQL
) &
author_delete_second_pid=$!

wait_for_backend_state \
  '33333333-3333-4333-8333-333333333333' 'Lock'
wait "$moderation_first_pid"
wait "$author_delete_second_pid"

if ! grep -qx 'true|content_deleted|1' \
  "$TMP_ROOT/moderation-first-vs-author-delete-action.log"; then
  echo "moderation-first author deletion returned an invalid effect" >&2
  cat "$TMP_ROOT/moderation-first-vs-author-delete-action.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_author_race_moderation_audit ON public.admin_logs;
DROP FUNCTION public.pause_author_race_moderation_audit();

DO $moderation_first_author_delete_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '33333333-3333-4333-8333-333333333333'
  ) OR EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '33333333-3333-4333-8333-333333333333'
  ) OR EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '10000000-0000-4000-8000-000000000032'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000032'
      AND status = 'resolved'
      AND resolved_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND resolved_at IS NOT NULL
      AND action_taken = 'content_deleted'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM public.admin_logs
    WHERE target_id = '10000000-0000-4000-8000-000000000032'
      AND action = 'delete_content'
  ) <> 1 THEN
    RAISE EXCEPTION
      'moderation-first author deletion left a partial report/audit state';
  END IF;
END
$moderation_first_author_delete_proof$;
SQL

# Reverse the order: auth deletion owns the author parent and pauses in its post
# cascade. The first moderation attempt must wait and fail P0002 before any
# report/audit write. A clean retry then resolves the still-pending report with
# the exact physically-missing acknowledgement.
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_profiles(id, role) VALUES
  ('44444444-4444-4444-8444-444444444444', 'user');
INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000033',
    '44444444-4444-4444-8444-444444444444'
  );
INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id
) VALUES (
  '30000000-0000-4000-8000-000000000033',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '10000000-0000-4000-8000-000000000033'
);

CREATE FUNCTION public.pause_author_post_auth_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.id = '10000000-0000-4000-8000-000000000033' THEN
    PERFORM pg_catalog.pg_sleep(1.2);
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER pause_author_post_auth_cascade
BEFORE DELETE ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.pause_author_post_auth_cascade();
SQL

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/author-delete-first-delete.log" 2>&1
DELETE FROM auth.users
WHERE id = '44444444-4444-4444-8444-444444444444';
SQL
) &
author_delete_first_pid=$!

wait_for_backend_state \
  '44444444-4444-4444-8444-444444444444' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/author-delete-first-action.log" 2>&1
\set VERBOSITY verbose
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT *
FROM public.moderate_report_queue_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-000000000033',
  'delete'
);
SQL
) &
moderation_second_pid=$!

wait_for_backend_state \
  '10000000-0000-4000-8000-000000000033' 'Lock'
wait "$author_delete_first_pid"
if wait "$moderation_second_pid"; then
  echo "author-delete-first moderation unexpectedly succeeded" >&2
  cat "$TMP_ROOT/author-delete-first-action.log" >&2
  exit 1
fi

if ! grep -q 'P0002.*reported content identity is unavailable' \
  "$TMP_ROOT/author-delete-first-action.log"; then
  echo "author-delete-first moderation did not fail at the auth guard" >&2
  cat "$TMP_ROOT/author-delete-first-action.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_author_post_auth_cascade ON public.posts;
DROP FUNCTION public.pause_author_post_auth_cascade();

DO $author_delete_first_pre_retry_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '44444444-4444-4444-8444-444444444444'
  ) OR EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '10000000-0000-4000-8000-000000000033'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000033'
      AND status = 'pending'
      AND resolved_by IS NULL
      AND resolved_at IS NULL
      AND action_taken IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.admin_logs
    WHERE target_id = '10000000-0000-4000-8000-000000000033'
  ) THEN
    RAISE EXCEPTION
      'failed author-delete-first attempt wrote partial moderation state';
  END IF;
END
$author_delete_first_pre_retry_proof$;

DO $author_delete_first_retry_proof$
DECLARE
  v_result record;
BEGIN
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role',
    'service_role',
    true
  );

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '10000000-0000-4000-8000-000000000033',
    'delete'
  );

  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_already_absent'
     OR v_result.author_id IS NOT NULL
     OR v_result.content_soft_deleted IS NOT NULL
     OR v_result.content_affected_count <> 0
     OR v_result.report_count <> 1
  THEN
    RAISE EXCEPTION
      'author-delete-first retry acknowledgement is invalid: %', v_result;
  END IF;
END
$author_delete_first_retry_proof$;
SQL

# The actor identity follows the same parent-first rule. When moderation wins,
# actor deletion waits, then SET NULL/CASCADE cleanup removes resolved_by and
# the actor-owned audit without reverting the dismissed report.
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('55555555-5555-4555-8555-555555555555');
INSERT INTO public.user_profiles(id, role) VALUES
  ('55555555-5555-4555-8555-555555555555', 'admin');
INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000034',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id
) VALUES (
  '30000000-0000-4000-8000-000000000034',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '10000000-0000-4000-8000-000000000034'
);
INSERT INTO public.user_strikes(
  id,
  user_id,
  issued_by,
  reason,
  strike_type
) VALUES (
  '70000000-0000-4000-8000-000000000034',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '55555555-5555-4555-8555-555555555555',
  'Seed actor-reference cleanup proof',
  'warning'
);

CREATE FUNCTION public.pause_actor_race_moderation_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.target_id = '10000000-0000-4000-8000-000000000034' THEN
    PERFORM pg_catalog.pg_sleep(1.2);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pause_actor_race_moderation_audit
BEFORE INSERT ON public.admin_logs
FOR EACH ROW EXECUTE FUNCTION public.pause_actor_race_moderation_audit();
SQL

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/moderation-first-vs-actor-delete-action.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT applied::text || '|' || report_status || '|' || action_taken
FROM public.moderate_report_queue_atomic(
  '55555555-5555-4555-8555-555555555555',
  'post',
  '10000000-0000-4000-8000-000000000034',
  'approve'
);
SQL
) &
actor_moderation_first_pid=$!

wait_for_backend_state \
  '10000000-0000-4000-8000-000000000034' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/moderation-first-vs-actor-delete-delete.log" 2>&1
DELETE FROM auth.users
WHERE id = '55555555-5555-4555-8555-555555555555';
SQL
) &
actor_delete_second_pid=$!

wait_for_backend_state \
  '55555555-5555-4555-8555-555555555555' 'Lock'
wait "$actor_moderation_first_pid"
wait "$actor_delete_second_pid"

if ! grep -qx 'true|dismissed|approved_content' \
  "$TMP_ROOT/moderation-first-vs-actor-delete-action.log"; then
  echo "moderation-first actor deletion returned an invalid acknowledgement" >&2
  cat "$TMP_ROOT/moderation-first-vs-actor-delete-action.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_actor_race_moderation_audit ON public.admin_logs;
DROP FUNCTION public.pause_actor_race_moderation_audit();

DO $moderation_first_actor_delete_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '55555555-5555-4555-8555-555555555555'
  ) OR EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '55555555-5555-4555-8555-555555555555'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000034'
      AND status = 'dismissed'
      AND resolved_by IS NULL
      AND resolved_at IS NOT NULL
      AND action_taken = 'approved_content'
  ) OR EXISTS (
    SELECT 1
    FROM public.admin_logs
    WHERE target_id = '10000000-0000-4000-8000-000000000034'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_strikes
    WHERE id = '70000000-0000-4000-8000-000000000034'
      AND issued_by IS NULL
  ) THEN
    RAISE EXCEPTION
      'moderation-first actor deletion left invalid FK cleanup state';
  END IF;
END
$moderation_first_actor_delete_proof$;
SQL

# When actor deletion wins, moderation waits on that auth parent and fails the
# exact administrator guard before locking content/reports. A surviving admin
# can retry the untouched pending report exactly once.
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('66666666-6666-4666-8666-666666666666');
INSERT INTO public.user_profiles(id, role) VALUES
  ('66666666-6666-4666-8666-666666666666', 'admin');
INSERT INTO public.posts(id, author_id) VALUES
  (
    '10000000-0000-4000-8000-000000000035',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
INSERT INTO public.content_reports(
  id,
  reporter_id,
  content_type,
  content_id
) VALUES (
  '30000000-0000-4000-8000-000000000035',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '10000000-0000-4000-8000-000000000035'
);

CREATE FUNCTION public.pause_actor_profile_auth_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.id = '66666666-6666-4666-8666-666666666666' THEN
    PERFORM pg_catalog.pg_sleep(1.2);
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER pause_actor_profile_auth_cascade
BEFORE DELETE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.pause_actor_profile_auth_cascade();
SQL

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/actor-delete-first-delete.log" 2>&1
DELETE FROM auth.users
WHERE id = '66666666-6666-4666-8666-666666666666';
SQL
) &
actor_delete_first_pid=$!

wait_for_backend_state \
  '66666666-6666-4666-8666-666666666666' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' \
    >"$TMP_ROOT/actor-delete-first-action.log" 2>&1
\set VERBOSITY verbose
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT *
FROM public.moderate_report_queue_atomic(
  '66666666-6666-4666-8666-666666666666',
  'post',
  '10000000-0000-4000-8000-000000000035',
  'approve'
);
SQL
) &
actor_moderation_second_pid=$!

wait_for_backend_state \
  '10000000-0000-4000-8000-000000000035' 'Lock'
wait "$actor_delete_first_pid"
if wait "$actor_moderation_second_pid"; then
  echo "actor-delete-first moderation unexpectedly succeeded" >&2
  cat "$TMP_ROOT/actor-delete-first-action.log" >&2
  exit 1
fi

if ! grep -q '42501.*administrator identity is unavailable' \
  "$TMP_ROOT/actor-delete-first-action.log"; then
  echo "actor-delete-first moderation did not fail at the actor auth guard" >&2
  cat "$TMP_ROOT/actor-delete-first-action.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_actor_profile_auth_cascade ON public.user_profiles;
DROP FUNCTION public.pause_actor_profile_auth_cascade();

DO $actor_delete_first_pre_retry_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '66666666-6666-4666-8666-666666666666'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000035'
      AND status = 'pending'
      AND resolved_by IS NULL
      AND resolved_at IS NULL
      AND action_taken IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.admin_logs
    WHERE target_id = '10000000-0000-4000-8000-000000000035'
  ) THEN
    RAISE EXCEPTION
      'failed actor-delete-first attempt wrote partial moderation state';
  END IF;
END
$actor_delete_first_pre_retry_proof$;

DO $actor_delete_first_retry_proof$
DECLARE
  v_result record;
BEGIN
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role',
    'service_role',
    true
  );

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '10000000-0000-4000-8000-000000000035',
    'approve'
  );

  IF NOT v_result.applied
     OR v_result.report_status <> 'dismissed'
     OR v_result.action_taken <> 'approved_content'
     OR v_result.report_count <> 1
  THEN
    RAISE EXCEPTION
      'actor-delete-first retry acknowledgement is invalid: %', v_result;
  END IF;
END
$actor_delete_first_retry_proof$;
SQL

echo "atomic report moderation queue PG17 proof passed"
