#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for single-report soft deletion, strict retry
# semantics, rollback, replay, ACLs, and the shared moderation lock order.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716163000_atomic_single_report_resolution.sql"
OPERATION_MIGRATION="$ROOT_DIR/supabase/migrations/20260716160000_report_moderation_operation_id.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/single-report-resolution-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((55700 + RANDOM % 200))
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -240 "$LOG_FILE" >&2 || true
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

  for _attempt in {1..300}; do
    state_count="$(psql_cmd -Atc "
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE pid <> pg_catalog.pg_backend_pid()
        AND query LIKE '%${query_fragment}%'
        AND wait_event_type = '${wait_event_type}'
        AND ('${wait_event}' = '' OR wait_event = '${wait_event}')
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
  parent_id uuid REFERENCES public.comments(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT 'test comment',
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

CREATE TABLE public.content_reports (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  content_id text NOT NULL,
  reason text NOT NULL DEFAULT 'spam',
  description text,
  images text[] NOT NULL DEFAULT ARRAY[]::text[],
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

CREATE TABLE public.admin_logs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.now()
);

CREATE FUNCTION public.guard_canonical_comment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() > 1
     OR pg_catalog.current_setting('app.comment_mutation_path', true) =
       'moderate_comment'
  THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT'
     AND NEW.deleted_at IS NULL
     AND NEW.deleted_by IS NULL
     AND NEW.delete_reason IS NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'direct comment mutation disabled' USING ERRCODE = '42501';
END
$$;

CREATE FUNCTION public.cascade_comment_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.parent_id IS NULL
     AND OLD.deleted_at IS NULL
     AND NEW.deleted_at IS NOT NULL
  THEN
    UPDATE public.comments AS reply
    SET deleted_at = NEW.deleted_at,
        deleted_by = NEW.deleted_by,
        delete_reason = NEW.delete_reason
    WHERE reply.parent_id = NEW.id
      AND reply.deleted_at IS NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_comments_00_guard_canonical_mutation
BEFORE INSERT OR DELETE OR UPDATE OF deleted_at, deleted_by, delete_reason, content, updated_at
ON public.comments
FOR EACH ROW EXECUTE FUNCTION public.guard_canonical_comment_mutation();

CREATE TRIGGER trg_comments_10_cascade_soft_delete
AFTER UPDATE OF deleted_at ON public.comments
FOR EACH ROW EXECUTE FUNCTION public.cascade_comment_soft_delete();

CREATE FUNCTION public.moderate_comment(
  p_comment_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (post_id uuid, affected_count integer, comment_count integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_id uuid;
  v_deleted_at timestamptz;
  v_previous_path text;
BEGIN
  IF p_action <> 'soft_delete' THEN
    RAISE EXCEPTION 'test moderate_comment accepts only soft_delete';
  END IF;
  SELECT comment_row.post_id INTO v_post_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.posts AS post_row
  WHERE post_row.id = v_post_id FOR UPDATE;
  PERFORM 1 FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id FOR UPDATE;

  SELECT pg_catalog.count(*)::integer
  INTO affected_count
  FROM public.comments AS affected_comment
  WHERE (
    affected_comment.id = p_comment_id
    OR affected_comment.parent_id = p_comment_id
  ) AND affected_comment.deleted_at IS NULL;

  v_previous_path := pg_catalog.current_setting('app.comment_mutation_path', true);
  PERFORM pg_catalog.set_config('app.comment_mutation_path', 'moderate_comment', true);
  v_deleted_at := pg_catalog.clock_timestamp();
  UPDATE public.comments AS target_comment
  SET deleted_at = v_deleted_at,
      deleted_by = p_actor_id,
      delete_reason = p_reason
  WHERE target_comment.id = p_comment_id
    AND target_comment.deleted_at IS NULL;
  PERFORM pg_catalog.set_config(
    'app.comment_mutation_path',
    COALESCE(v_previous_path, ''),
    true
  );

  post_id := v_post_id;
  SELECT pg_catalog.count(*)::integer INTO comment_count
  FROM public.comments AS active_comment
  WHERE active_comment.post_id = v_post_id
    AND active_comment.deleted_at IS NULL;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.moderate_comment(uuid, uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.moderate_comment(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.moderate_comment(uuid, uuid, text, text)
  TO service_role;

CREATE FUNCTION public.moderate_report_queue_atomic(
  p_actor_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_action text
)
RETURNS TABLE (
  applied boolean,
  result_action text,
  result_content_type text,
  result_content_id uuid,
  report_status text,
  report_count integer,
  action_taken text,
  author_id uuid,
  content_soft_deleted boolean,
  content_affected_count integer,
  strike_id uuid,
  strike_type text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation:' || p_content_type || ':' || p_content_id::text,
      0
    )
  );
  IF pg_catalog.current_setting('test.pause_queue', true) = 'on' THEN
    PERFORM pg_catalog.pg_sleep(1.1);
  END IF;
  UPDATE public.content_reports AS report_row
  SET status = CASE WHEN p_action = 'approve' THEN 'dismissed' ELSE 'resolved' END,
      action_taken = CASE
        WHEN p_action = 'approve' THEN 'approved_content'
        WHEN p_action = 'warn' THEN 'user_warned'
        ELSE 'content_already_absent'
      END,
      resolved_by = p_actor_id,
      resolved_at = pg_catalog.clock_timestamp()
  WHERE report_row.content_type = p_content_type
    AND report_row.content_id = p_content_id::text
    AND report_row.status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  applied := v_count > 0;
  result_action := p_action;
  result_content_type := p_content_type;
  result_content_id := p_content_id;
  report_status := CASE WHEN v_count > 0 AND p_action = 'approve' THEN 'dismissed'
                        WHEN v_count > 0 THEN 'resolved' ELSE NULL END;
  report_count := v_count;
  action_taken := CASE WHEN v_count = 0 THEN NULL
                       WHEN p_action = 'approve' THEN 'approved_content'
                       WHEN p_action = 'warn' THEN 'user_warned'
                       ELSE 'content_already_absent' END;
  author_id := NULL;
  content_soft_deleted := NULL;
  content_affected_count := 0;
  strike_id := NULL;
  strike_type := NULL;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.moderate_report_queue_atomic(uuid, text, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.moderate_report_queue_atomic(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.moderate_report_queue_atomic(uuid, text, uuid, text)
  TO service_role;

DO $$
DECLARE
  v_function regprocedure :=
    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'::regprocedure;
  v_digest text;
BEGIN
  SELECT pg_catalog.md5(function_row.prosrc) INTO STRICT v_digest
  FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = v_function;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-report-moderation-queue:v1:' || v_digest
  );
END
$$;
SQL

# Install the exact operation-ID queue boundary that immediately precedes this
# migration. The fixture's four-argument implementation is deliberately small,
# but the public five-argument wrapper, result contract, seal, and ACL are the
# production definitions whose digest the single-report migration pins.
sed -n '429,1357p' "$OPERATION_MIGRATION" | psql_cmd >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
CREATE FUNCTION public.test_queue_transition_with_target_lock(
  p_actor_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_action text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_action_taken text;
  v_affected_count integer := 0;
  v_author_id uuid;
  v_now timestamptz;
  v_report_ids uuid[] := ARRAY[]::uuid[];
  v_report_status text;
  v_strike_id uuid;
  v_strike_type text;
  v_target_id uuid;
  v_target_type text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation:' || p_content_type || ':' || p_content_id::text,
      0
    )
  );
  IF pg_catalog.current_setting('test.pause_queue', true) = 'on' THEN
    PERFORM pg_catalog.pg_sleep(1.1);
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(locked_report.id ORDER BY locked_report.id),
    ARRAY[]::uuid[]
  )
  INTO v_report_ids
  FROM (
    SELECT report_row.id
    FROM public.content_reports AS report_row
    WHERE report_row.content_type = p_content_type
      AND report_row.content_id = p_content_id::text
      AND report_row.status = 'pending'
    ORDER BY report_row.id
    FOR UPDATE
  ) AS locked_report;

  IF pg_catalog.cardinality(v_report_ids) = 0 THEN
    RETURN false;
  END IF;

  IF p_content_type = 'post' THEN
    SELECT post_row.author_id
    INTO STRICT v_author_id
    FROM public.posts AS post_row
    WHERE post_row.id = p_content_id;
  ELSE
    SELECT comment_row.user_id
    INTO STRICT v_author_id
    FROM public.comments AS comment_row
    WHERE comment_row.id = p_content_id;
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF p_action = 'approve' THEN
    v_report_status := 'dismissed';
    v_action_taken := 'approved_content';
    v_target_type := p_content_type;
    v_target_id := p_content_id;
  ELSIF p_action = 'warn' THEN
    v_report_status := 'resolved';
    v_action_taken := 'user_warned';
    v_target_type := 'user';
    v_target_id := v_author_id;
    v_strike_id := '49000000-0000-4000-8000-000000000001';
    v_strike_type := 'warning';
  ELSIF p_action IN ('delete', 'ban') THEN
    v_report_status := 'resolved';
    v_action_taken := CASE
      WHEN p_action = 'ban' THEN 'user_banned'
      ELSE 'content_already_absent'
    END;
    v_target_type := CASE WHEN p_action = 'ban' THEN 'user' ELSE p_content_type END;
    v_target_id := CASE WHEN p_action = 'ban' THEN v_author_id ELSE p_content_id END;

    IF p_content_type = 'post' THEN
      UPDATE public.posts AS moderated_post
      SET deleted_at = v_now,
          deleted_by = p_actor_id,
          delete_reason = 'Queue test moderation'
      WHERE moderated_post.id = p_content_id
        AND moderated_post.deleted_at IS NULL;
      GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    ELSE
      UPDATE public.comments AS moderated_comment
      SET deleted_at = v_now,
          deleted_by = p_actor_id,
          delete_reason = 'Queue test moderation'
      WHERE moderated_comment.id = p_content_id
        AND moderated_comment.deleted_at IS NULL;
      GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    END IF;
    IF v_affected_count > 0 AND p_action = 'delete' THEN
      v_action_taken := 'content_deleted';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported queue test action';
  END IF;

  UPDATE public.content_reports AS transitioned_report
  SET status = v_report_status,
      action_taken = v_action_taken,
      resolved_by = p_actor_id,
      resolved_at = v_now
  WHERE transitioned_report.id = ANY (v_report_ids)
    AND transitioned_report.status = 'pending';

  INSERT INTO public.admin_logs(
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    p_actor_id,
    CASE
      WHEN p_action = 'approve' THEN 'dismiss_reports'
      WHEN p_action = 'warn' THEN 'issue_warning'
      WHEN p_action = 'ban' THEN 'ban_user_from_queue'
      ELSE 'delete_content'
    END,
    v_target_type,
    v_target_id,
    pg_catalog.jsonb_build_object(
      'content_type', p_content_type,
      'content_id', p_content_id,
      'report_count', pg_catalog.cardinality(v_report_ids),
      'report_ids', pg_catalog.to_jsonb(v_report_ids),
      'report_status', v_report_status,
      'action_taken', v_action_taken,
      'author_id', v_author_id,
      'content_affected_count', v_affected_count,
      'strike_id', v_strike_id,
      'strike_type', v_strike_type
    )
  );

  RETURN true;
END
$$;

DO $acl_proof$
DECLARE
  v_function regprocedure :=
    'public.resolve_content_report_atomic(uuid,uuid,text,text)'::regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'single report resolution RPC ACL is not service-only';
  END IF;
END
$acl_proof$;

SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
DO $role_guard_proof$
BEGIN
  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000001',
      'resolve',
      NULL
    );
    RAISE EXCEPTION 'non-service claim unexpectedly crossed the RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$role_guard_proof$;

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

INSERT INTO auth.users(id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('99999999-9999-4999-8999-999999999999'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff');

INSERT INTO public.user_profiles(id, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin'),
  ('99999999-9999-4999-8999-999999999999', 'admin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'user'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'user'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'user'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'user');

INSERT INTO public.posts(id, author_id) VALUES
  ('10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000003', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('10000000-0000-4000-8000-000000000004', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('10000000-0000-4000-8000-000000000005', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

INSERT INTO public.comments(id, post_id, user_id, parent_id) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    NULL
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '20000000-0000-4000-8000-000000000001'
  );

INSERT INTO public.content_reports(id, reporter_id, content_type, content_id) VALUES
  ('30000000-0000-4000-8000-000000000001', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000002', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'comment', '20000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000003', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000003'),
  ('30000000-0000-4000-8000-000000000004', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'comment', '20000000-0000-4000-8000-000000000004'),
  ('30000000-0000-4000-8000-000000000005', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'user', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('30000000-0000-4000-8000-000000000006', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'message', '50000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000007', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'post', '10000000-0000-4000-8000-000000000001');

DO $post_resolution_proof$
DECLARE
  v_result record;
  v_log_id uuid;
  v_log_count integer;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000001',
    'resolve',
    '  confirmed abuse  '
  );
  IF NOT v_result.applied
     OR v_result.result_code <> 'applied'
     OR v_result.report_status <> 'resolved'
     OR v_result.action_taken <> 'content_deleted'
     OR v_result.content_soft_deleted IS NOT TRUE
     OR v_result.content_affected_count <> 1
     OR v_result.admin_log_id IS NULL
  THEN
    RAISE EXCEPTION 'post resolution acknowledgement invalid: %', v_result;
  END IF;
  v_log_id := v_result.admin_log_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND deleted_at IS NOT NULL
      AND delete_reason = 'confirmed abuse'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000001'
      AND status = 'resolved'
      AND action_taken = 'content_deleted'
  ) THEN
    RAISE EXCEPTION 'post/report state did not commit atomically';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_log_count FROM public.admin_logs;
  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000001',
    'resolve',
    'confirmed abuse'
  );
  IF v_result.applied
     OR v_result.result_code <> 'already_processed'
     OR v_result.action_taken <> 'content_deleted'
     OR v_result.content_soft_deleted IS NOT TRUE
     OR v_result.content_affected_count <> 0
     OR v_result.admin_log_id IS DISTINCT FROM v_log_id
     OR (SELECT pg_catalog.count(*) FROM public.admin_logs) <> v_log_count
  THEN
    RAISE EXCEPTION 'response-loss retry was not a strict audited no-op: %', v_result;
  END IF;

  BEGIN
    PERFORM public.resolve_content_report_atomic(
      '99999999-9999-4999-8999-999999999999',
      '30000000-0000-4000-8000-000000000001',
      'resolve',
      'confirmed abuse'
    );
    RAISE EXCEPTION 'different actor reused single-report retry evidence';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000001',
      'resolve',
      'different reason'
    );
    RAISE EXCEPTION 'different reason reused single-report retry evidence';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  IF (SELECT pg_catalog.count(*) FROM public.admin_logs) <> v_log_count THEN
    RAISE EXCEPTION 'rejected retry changed audit state';
  END IF;
END
$post_resolution_proof$;

DO $comment_resolution_proof$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000002',
    'resolve',
    NULL
  );
  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_deleted'
     OR v_result.content_affected_count <> 2
  THEN
    RAISE EXCEPTION 'comment resolution acknowledgement invalid: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.comments
    WHERE id IN (
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002'
    ) AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'canonical comment soft-delete did not hide the tree';
  END IF;
END
$comment_resolution_proof$;

DO $absence_and_dismiss_proof$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000003',
    'dismiss',
    '   '
  );
  IF NOT v_result.applied
     OR v_result.report_status <> 'dismissed'
     OR v_result.action_taken <> 'dismissed'
     OR v_result.content_soft_deleted IS NOT NULL
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'dismiss acknowledgement invalid: %', v_result;
  END IF;
  IF (SELECT deleted_at FROM public.posts
      WHERE id = '10000000-0000-4000-8000-000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'dismiss mutated content';
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000004',
    'resolve',
    NULL
  );
  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_already_absent'
     OR v_result.content_soft_deleted IS NOT NULL
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'physical absence acknowledgement invalid: %', v_result;
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000006',
    'dismiss',
    NULL
  );
  IF NOT v_result.applied
     OR v_result.content_type <> 'message'
     OR v_result.action_taken <> 'dismissed'
  THEN
    RAISE EXCEPTION 'message dismiss acknowledgement invalid: %', v_result;
  END IF;
END
$absence_and_dismiss_proof$;

DO $unsupported_proof$
DECLARE
  v_before_logs bigint := (SELECT pg_catalog.count(*) FROM public.admin_logs);
BEGIN
  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000005',
      'resolve',
      NULL
    );
    RAISE EXCEPTION 'user report resolution was not rejected';
  EXCEPTION WHEN feature_not_supported THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000005'
      AND status = 'pending'
  ) OR (SELECT pg_catalog.count(*) FROM public.admin_logs) <> v_before_logs THEN
    RAISE EXCEPTION 'unsupported resolution left partial state';
  END IF;
END
$unsupported_proof$;

DO $one_report_only_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000007'
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'single resolution consumed another reporter pending row';
  END IF;
END
$one_report_only_proof$;
SQL

psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

INSERT INTO public.posts(id, author_id, deleted_at, deleted_by, delete_reason) VALUES
  (
    '10000000-0000-4000-8000-000000000010',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '2026-07-15T00:00:00Z',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Earlier moderation'
  ),
  (
    '10000000-0000-4000-8000-000000000011',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    NULL, NULL, NULL
  ),
  (
    '10000000-0000-4000-8000-000000000012',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    NULL, NULL, NULL
  ),
  (
    '10000000-0000-4000-8000-000000000013',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    NULL, NULL, NULL
  ),
  (
    '10000000-0000-4000-8000-000000000014',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    NULL, NULL, NULL
  );

INSERT INTO public.comments(id, post_id, user_id) VALUES (
  '20000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000011',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
);
SELECT pg_catalog.set_config('app.comment_mutation_path', 'moderate_comment', false);
UPDATE public.comments
SET deleted_at = '2026-07-15T00:00:00Z',
    deleted_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    delete_reason = 'Earlier moderation'
WHERE id = '20000000-0000-4000-8000-000000000010';
SELECT pg_catalog.set_config('app.comment_mutation_path', '', false);

INSERT INTO public.content_reports(id, reporter_id, content_type, content_id) VALUES
  ('30000000-0000-4000-8000-000000000010', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000010'),
  ('30000000-0000-4000-8000-000000000011', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'comment', '20000000-0000-4000-8000-000000000010'),
  ('30000000-0000-4000-8000-000000000012', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000099'),
  ('30000000-0000-4000-8000-000000000013', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000012'),
  ('30000000-0000-4000-8000-000000000014', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000013'),
  ('30000000-0000-4000-8000-000000000015', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000014');

DO $already_absent_proof$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000010',
    'resolve',
    NULL
  );
  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_already_absent'
     OR v_result.content_soft_deleted IS NOT TRUE
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'soft-deleted post acknowledgement invalid: %', v_result;
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000011',
    'resolve',
    NULL
  );
  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_already_absent'
     OR v_result.content_soft_deleted IS NOT TRUE
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'soft-deleted comment acknowledgement invalid: %', v_result;
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000012',
    'resolve',
    NULL
  );
  IF NOT v_result.applied
     OR v_result.action_taken <> 'content_already_absent'
     OR v_result.content_soft_deleted IS NOT NULL
     OR v_result.content_affected_count <> 0
  THEN
    RAISE EXCEPTION 'physically absent post acknowledgement invalid: %', v_result;
  END IF;
END
$already_absent_proof$;

UPDATE public.content_reports
SET status = 'resolved',
    action_taken = 'user_banned',
    resolved_at = pg_catalog.clock_timestamp(),
    resolved_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
WHERE id = '30000000-0000-4000-8000-000000000005';

DO $processed_unsupported_proof$
BEGIN
  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000005',
      'resolve',
      NULL
    );
    RAISE EXCEPTION 'processed user report forged a resolution no-op';
  EXCEPTION WHEN feature_not_supported THEN NULL;
  END;
END
$processed_unsupported_proof$;

SELECT public.test_queue_transition_with_target_lock(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-000000000012',
  'warn'
);
SELECT public.test_queue_transition_with_target_lock(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-000000000013',
  'approve'
);

DO $equivalent_queue_outcome_proof$
DECLARE
  v_result record;
BEGIN
  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000013',
      'resolve',
      NULL
    );
    RAISE EXCEPTION 'queue warning was treated as content deletion';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000014',
    'dismiss',
    NULL
  );
  IF v_result.applied
     OR v_result.result_code <> 'already_processed'
     OR v_result.report_status <> 'dismissed'
     OR v_result.action_taken <> 'approved_content'
     OR v_result.admin_log_id IS NULL
  THEN
    RAISE EXCEPTION 'queue approval was not an equivalent dismiss no-op: %', v_result;
  END IF;

  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000001',
      'dismiss',
      NULL
    );
    RAISE EXCEPTION 'resolved report was treated as a dismiss retry';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000003',
      'resolve',
      NULL
    );
    RAISE EXCEPTION 'dismissed report was treated as a resolution retry';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END
$equivalent_queue_outcome_proof$;

INSERT INTO public.posts(id, author_id) VALUES
  ('10000000-0000-4000-8000-000000000015', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000016', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000017', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000018', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000019', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000020', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000021', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000022', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000023', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000024', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('10000000-0000-4000-8000-000000000025', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

UPDATE public.posts
SET deleted_at = '2026-07-16T02:00:00Z',
    deleted_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    delete_reason = 'Historical test moderation'
WHERE id = ANY (ARRAY[
  '10000000-0000-4000-8000-000000000015',
  '10000000-0000-4000-8000-000000000016',
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000022',
  '10000000-0000-4000-8000-000000000023',
  '10000000-0000-4000-8000-000000000024'
]::uuid[]);

INSERT INTO public.content_reports(id, reporter_id, content_type, content_id) VALUES
  ('30000000-0000-4000-8000-000000000016', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000015'),
  ('30000000-0000-4000-8000-000000000017', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000016'),
  ('30000000-0000-4000-8000-000000000018', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000017'),
  ('30000000-0000-4000-8000-000000000019', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000018'),
  ('30000000-0000-4000-8000-000000000020', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000019'),
  ('30000000-0000-4000-8000-000000000021', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000020'),
  ('30000000-0000-4000-8000-000000000022', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000021'),
  ('30000000-0000-4000-8000-000000000023', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000022'),
  ('30000000-0000-4000-8000-000000000024', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000023'),
  ('30000000-0000-4000-8000-000000000025', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000024'),
  ('30000000-0000-4000-8000-000000000026', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '10000000-0000-4000-8000-000000000025'),
  ('30000000-0000-4000-8000-000000000027', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'post', '10000000-0000-4000-8000-000000000025');

UPDATE public.content_reports AS report_row
SET status = evidence.status,
    action_taken = evidence.action_taken,
    resolved_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resolved_at = evidence.resolved_at
FROM (VALUES
  ('30000000-0000-4000-8000-000000000016'::uuid, 'resolved', 'content_deleted', '2026-07-16T02:00:16Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000017'::uuid, 'resolved', 'content_deleted', '2026-07-16T02:00:17Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000018'::uuid, 'dismissed', 'approved_content', '2026-07-16T02:00:18Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000019'::uuid, 'dismissed', 'approved_content', '2026-07-16T02:00:19Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000020'::uuid, 'resolved', 'content_deleted', '2026-07-16T02:00:20Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000021'::uuid, 'dismissed', 'approved_content', '2026-07-16T02:00:21Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000022'::uuid, 'resolved', 'content_deleted', '2026-07-16T02:00:22Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000023'::uuid, 'resolved', 'content_deleted', '2026-07-16T02:00:23Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000024'::uuid, 'resolved', 'content_deleted', '2026-07-16T02:00:24Z'::timestamptz),
  ('30000000-0000-4000-8000-000000000025'::uuid, 'resolved', 'content_deleted', '2026-07-16T02:00:25Z'::timestamptz)
) AS evidence(id, status, action_taken, resolved_at)
WHERE report_row.id = evidence.id;

-- Structurally forged single audit: every business value is plausible, but
-- the extra key proves this was not the exact object emitted by the RPC.
INSERT INTO public.admin_logs(admin_id, action, target_type, target_id, details)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'resolve_report',
  'report',
  '30000000-0000-4000-8000-000000000017',
  pg_catalog.jsonb_build_object(
    'report_id', '30000000-0000-4000-8000-000000000017'::uuid,
    'report_status', 'resolved',
    'content_type', 'post',
    'content_id', '10000000-0000-4000-8000-000000000016'::uuid,
    'action_taken', 'content_deleted',
    'content_soft_deleted', true,
    'content_affected_count', 1,
    'reason', NULL,
    'resolved_at', '2026-07-16T02:00:17Z'::timestamptz,
    'forged_extra_key', true
  )
);

INSERT INTO public.admin_logs(admin_id, action, target_type, target_id, details)
VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dismiss_reports',
    'post',
    '10000000-0000-4000-8000-000000000017',
    pg_catalog.jsonb_build_object(
      'content_type', 'post',
      'content_id', '10000000-0000-4000-8000-000000000017'::uuid,
      'report_count', 2,
      'report_ids', pg_catalog.to_jsonb(ARRAY[
        '30000000-0000-4000-8000-000000000018'::uuid,
        '30000000-0000-4000-8000-000000000018'::uuid
      ]),
      'report_status', 'dismissed',
      'action_taken', 'approved_content',
      'author_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
      'content_affected_count', 0,
      'strike_id', NULL,
      'strike_type', NULL
    )
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dismiss_reports',
    'post',
    '10000000-0000-4000-8000-000000000018',
    pg_catalog.jsonb_build_object(
      'content_type', 'post',
      'content_id', '10000000-0000-4000-8000-000000000018'::uuid,
      'report_count', 1,
      'report_ids', pg_catalog.to_jsonb(ARRAY[
        '30000000-0000-4000-8000-000000000019'::uuid
      ]),
      'report_status', 'dismissed',
      'action_taken', 'approved_content',
      'author_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
      'content_affected_count', 1,
      'strike_id', NULL,
      'strike_type', NULL
    )
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'delete_content',
    'post',
    '10000000-0000-4000-8000-000000000019',
    pg_catalog.jsonb_build_object(
      'content_type', 'post',
      'content_id', '10000000-0000-4000-8000-000000000019'::uuid,
      'report_count', 1,
      'report_ids', pg_catalog.to_jsonb(ARRAY[
        '30000000-0000-4000-8000-000000000020'::uuid
      ]),
      'report_status', 'resolved',
      'action_taken', 'content_deleted',
      'author_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
      'content_affected_count', 1,
      'strike_id', NULL,
      'strike_type', NULL
    )
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dismiss_reports',
    'post',
    '10000000-0000-4000-8000-000000000019',
    pg_catalog.jsonb_build_object(
      'content_type', 'post',
      'content_id', '10000000-0000-4000-8000-000000000020'::uuid,
      'report_count', 1,
      'report_ids', pg_catalog.to_jsonb(ARRAY[
        '30000000-0000-4000-8000-000000000021'::uuid
      ]),
      'report_status', 'dismissed',
      'action_taken', 'approved_content',
      'author_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
      'content_affected_count', 0,
      'strike_id', NULL,
      'strike_type', NULL
    )
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'delete_content',
    'post',
    '10000000-0000-4000-8000-000000000021',
    pg_catalog.jsonb_build_object(
      'content_type', 'post',
      'content_id', '10000000-0000-4000-8000-000000000021'::uuid,
      'report_count', 1,
      'report_ids', pg_catalog.to_jsonb(ARRAY[
        '30000000-0000-4000-8000-000000000022'::uuid
      ]),
      'report_status', 'dismissed',
      'action_taken', 'content_deleted',
      'author_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
      'content_affected_count', 1,
      'strike_id', NULL,
      'strike_type', NULL
    )
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'delete_content',
    'post',
    '10000000-0000-4000-8000-000000000022',
    pg_catalog.jsonb_build_object(
      'content_type', 'post',
      'content_id', '10000000-0000-4000-8000-000000000019'::uuid,
      'report_count', 1,
      'report_ids', pg_catalog.to_jsonb(ARRAY[
        '30000000-0000-4000-8000-000000000023'::uuid
      ]),
      'report_status', 'resolved',
      'action_taken', 'content_deleted',
      'author_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
      'content_affected_count', 1,
      'strike_id', NULL,
      'strike_type', NULL
    )
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'delete_content',
    'post',
    '10000000-0000-4000-8000-000000000023',
    pg_catalog.jsonb_build_object(
      'content_type', 'post',
      'content_id', '10000000-0000-4000-8000-000000000023'::uuid,
      'report_count', 1,
      'report_ids', pg_catalog.to_jsonb(ARRAY[
        '30000000-0000-4000-8000-000000000024'::uuid
      ]),
      'report_status', 'resolved',
      'action_taken', 'content_already_absent',
      'author_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
      'content_affected_count', 0,
      'strike_id', NULL,
      'strike_type', NULL
    )
  );

-- Exact nine-key shape, but the top-level action is for the opposite request.
INSERT INTO public.admin_logs(admin_id, action, target_type, target_id, details)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dismiss_report',
  'report',
  '30000000-0000-4000-8000-000000000025',
  pg_catalog.jsonb_build_object(
    'report_id', '30000000-0000-4000-8000-000000000025'::uuid,
    'report_status', 'resolved',
    'content_type', 'post',
    'content_id', '10000000-0000-4000-8000-000000000024'::uuid,
    'action_taken', 'content_deleted',
    'content_soft_deleted', true,
    'content_affected_count', 1,
    'reason', NULL,
    'resolved_at', '2026-07-16T02:00:25Z'::timestamptz
  )
);

DO $forged_audit_evidence_proof$
DECLARE
  v_before_logs bigint := (SELECT pg_catalog.count(*) FROM public.admin_logs);
  v_case record;
BEGIN
  FOR v_case IN
    SELECT *
    FROM (VALUES
      ('30000000-0000-4000-8000-000000000016'::uuid, 'resolve'),
      ('30000000-0000-4000-8000-000000000017'::uuid, 'resolve'),
      ('30000000-0000-4000-8000-000000000018'::uuid, 'dismiss'),
      ('30000000-0000-4000-8000-000000000019'::uuid, 'dismiss'),
      ('30000000-0000-4000-8000-000000000020'::uuid, 'resolve'),
      ('30000000-0000-4000-8000-000000000021'::uuid, 'dismiss'),
      ('30000000-0000-4000-8000-000000000022'::uuid, 'resolve'),
      ('30000000-0000-4000-8000-000000000023'::uuid, 'resolve'),
      ('30000000-0000-4000-8000-000000000024'::uuid, 'resolve'),
      ('30000000-0000-4000-8000-000000000025'::uuid, 'resolve')
    ) AS rejected_case(report_id, requested_action)
  LOOP
    BEGIN
      PERFORM public.resolve_content_report_atomic(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        v_case.report_id,
        v_case.requested_action,
        NULL
      );
      RAISE EXCEPTION 'forged or missing audit was accepted for %', v_case.report_id;
    EXCEPTION WHEN serialization_failure THEN NULL;
    END;
  END LOOP;

  IF (SELECT pg_catalog.count(*) FROM public.admin_logs) <> v_before_logs THEN
    RAISE EXCEPTION 'rejected audit evidence changed audit state';
  END IF;
END
$forged_audit_evidence_proof$;

SELECT public.test_queue_transition_with_target_lock(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '10000000-0000-4000-8000-000000000025',
  'delete'
);

DO $exact_queue_batch_retry_proof$
DECLARE
  v_before_logs bigint := (SELECT pg_catalog.count(*) FROM public.admin_logs);
  v_expected_log_id uuid;
  v_result record;
BEGIN
  SELECT audit_row.id INTO STRICT v_expected_log_id
  FROM public.admin_logs AS audit_row
  WHERE audit_row.details -> 'report_ids' = pg_catalog.to_jsonb(ARRAY[
    '30000000-0000-4000-8000-000000000026'::uuid,
    '30000000-0000-4000-8000-000000000027'::uuid
  ]);

  SELECT * INTO STRICT v_result
  FROM public.resolve_content_report_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '30000000-0000-4000-8000-000000000026',
    'resolve',
    NULL
  );
  IF v_result.applied
     OR v_result.result_code <> 'already_processed'
     OR v_result.action_taken <> 'content_deleted'
     OR v_result.content_soft_deleted IS NOT TRUE
     OR v_result.content_affected_count <> 0
     OR v_result.admin_log_id IS DISTINCT FROM v_expected_log_id
     OR (SELECT pg_catalog.count(*) FROM public.admin_logs) <> v_before_logs
  THEN
    RAISE EXCEPTION 'exact queue batch retry acknowledgement invalid: %', v_result;
  END IF;

  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000027',
      'resolve',
      'invented single-report reason'
    );
    RAISE EXCEPTION 'queue audit accepted a reason it never recorded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END
$exact_queue_batch_retry_proof$;

DO $database_reason_bound_proof$
BEGIN
  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000015',
      'resolve',
      pg_catalog.repeat('x', 501)
    );
    RAISE EXCEPTION 'oversized database reason was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '30000000-0000-4000-8000-000000000015'
      AND status = 'pending'
  ) OR (SELECT deleted_at FROM public.posts
        WHERE id = '10000000-0000-4000-8000-000000000014') IS NOT NULL THEN
    RAISE EXCEPTION 'invalid reason left partial state';
  END IF;
END
$database_reason_bound_proof$;
SQL

# Force failures after the content mutation and after the report transition.
# Each complete function statement must roll back content, report, and audit.
psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

CREATE FUNCTION public.fail_selected_report_transition()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id = '30000000-0000-4000-8000-000000000015'::uuid THEN
    RAISE EXCEPTION 'forced report transition failure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fail_selected_report_transition
BEFORE UPDATE ON public.content_reports
FOR EACH ROW EXECUTE FUNCTION public.fail_selected_report_transition();

DO $transition_rollback_proof$
DECLARE
  v_before_logs bigint := (SELECT pg_catalog.count(*) FROM public.admin_logs);
BEGIN
  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000015',
      'resolve',
      NULL
    );
    RAISE EXCEPTION 'forced transition failure did not abort';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT deleted_at FROM public.posts
      WHERE id = '10000000-0000-4000-8000-000000000014') IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.content_reports
       WHERE id = '30000000-0000-4000-8000-000000000015'
         AND status = 'pending'
     )
     OR (SELECT pg_catalog.count(*) FROM public.admin_logs) <> v_before_logs
  THEN
    RAISE EXCEPTION 'transition failure left partial state';
  END IF;
END
$transition_rollback_proof$;

DROP TRIGGER fail_selected_report_transition ON public.content_reports;
DROP FUNCTION public.fail_selected_report_transition();

CREATE FUNCTION public.fail_selected_admin_log()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.target_id = '30000000-0000-4000-8000-000000000015'::uuid THEN
    RAISE EXCEPTION 'forced audit failure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fail_selected_admin_log
BEFORE INSERT ON public.admin_logs
FOR EACH ROW EXECUTE FUNCTION public.fail_selected_admin_log();

DO $audit_rollback_proof$
BEGIN
  BEGIN
    PERFORM public.resolve_content_report_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '30000000-0000-4000-8000-000000000015',
      'resolve',
      NULL
    );
    RAISE EXCEPTION 'forced audit failure did not abort';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT deleted_at FROM public.posts
      WHERE id = '10000000-0000-4000-8000-000000000014') IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.content_reports
       WHERE id = '30000000-0000-4000-8000-000000000015'
         AND status = 'pending'
     )
  THEN
    RAISE EXCEPTION 'audit failure left partial state';
  END IF;
END
$audit_rollback_proof$;

DROP TRIGGER fail_selected_admin_log ON public.admin_logs;
DROP FUNCTION public.fail_selected_admin_log();
SQL

# Test-only pause points make lock ownership observable without changing the
# production RPC. They are installed only after migration replay/preflight.
psql_cmd <<'SQL'
CREATE FUNCTION public.pause_selected_post_resolution()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('test.pause_post_id', true) = NEW.id::text
     AND OLD.deleted_at IS NULL
     AND NEW.deleted_at IS NOT NULL
  THEN
    PERFORM pg_catalog.pg_sleep(1.1);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pause_selected_post_resolution
BEFORE UPDATE OF deleted_at ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.pause_selected_post_resolution();

CREATE FUNCTION auth.pause_selected_user_delete()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('test.pause_auth_id', true) = OLD.id::text THEN
    PERFORM pg_catalog.pg_sleep(1.1);
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER pause_selected_user_delete
BEFORE DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION auth.pause_selected_user_delete();

CREATE FUNCTION public.test_submit_report_with_target_lock(
  p_report_id uuid,
  p_reporter_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_pause boolean
)
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-moderation:' || p_content_type || ':' || p_content_id::text,
      0
    )
  );
  IF p_pause THEN
    PERFORM pg_catalog.pg_sleep(1.1);
  END IF;
  INSERT INTO public.content_reports(
    id, reporter_id, content_type, content_id
  ) VALUES (
    p_report_id, p_reporter_id, p_content_type, p_content_id::text
  );
END
$$;

INSERT INTO auth.users(id) VALUES
  ('a1000000-0000-4000-8000-000000000001'),
  ('a1000000-0000-4000-8000-000000000002'),
  ('b1000000-0000-4000-8000-000000000001'),
  ('b1000000-0000-4000-8000-000000000002'),
  ('b1000000-0000-4000-8000-000000000003'),
  ('b1000000-0000-4000-8000-000000000004'),
  ('e1000000-0000-4000-8000-000000000001'),
  ('e1000000-0000-4000-8000-000000000002');

INSERT INTO public.user_profiles(id, role) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'admin'),
  ('a1000000-0000-4000-8000-000000000002', 'admin'),
  ('b1000000-0000-4000-8000-000000000001', 'user'),
  ('b1000000-0000-4000-8000-000000000002', 'user'),
  ('b1000000-0000-4000-8000-000000000003', 'user'),
  ('b1000000-0000-4000-8000-000000000004', 'user'),
  ('e1000000-0000-4000-8000-000000000001', 'user'),
  ('e1000000-0000-4000-8000-000000000002', 'user');

INSERT INTO public.posts(id, author_id) VALUES
  ('11000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'),
  ('11000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001'),
  ('11000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001'),
  ('11000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000002'),
  ('11000000-0000-4000-8000-000000000005', 'b1000000-0000-4000-8000-000000000001'),
  ('11000000-0000-4000-8000-000000000006', 'b1000000-0000-4000-8000-000000000002'),
  ('11000000-0000-4000-8000-000000000007', 'b1000000-0000-4000-8000-000000000003'),
  ('11000000-0000-4000-8000-000000000008', 'b1000000-0000-4000-8000-000000000004');

INSERT INTO public.content_reports(id, reporter_id, content_type, content_id) VALUES
  ('31000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000001'),
  ('31000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000002'),
  ('31000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000003'),
  ('31000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000004'),
  ('31000000-0000-4000-8000-000000000007', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000005'),
  ('31000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000006'),
  ('31000000-0000-4000-8000-000000000009', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000007'),
  ('31000000-0000-4000-8000-000000000010', 'e1000000-0000-4000-8000-000000000001', 'post', '11000000-0000-4000-8000-000000000008');
SQL

# Queue wins the shared target lock. Single resolution waits, observes the
# queue warning, and fails instead of falsely claiming that content was deleted.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/queue-first.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config('test.pause_queue', 'on', false);
SELECT /* queue_first_marker */ public.test_queue_transition_with_target_lock(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '11000000-0000-4000-8000-000000000001',
  'warn'
);
SQL
) &
queue_first_pid=$!
wait_for_backend_state 'queue_first_marker' 'Timeout' 'PgSleep'

(
  set +e
  psql_cmd -At <<'SQL' >"$TMP_ROOT/single-after-queue.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT /* single_after_queue_marker */ result_code
FROM public.resolve_content_report_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000001',
  'resolve',
  NULL
);
SQL
  echo "$?" >"$TMP_ROOT/single-after-queue.code"
) &
single_after_queue_pid=$!
wait_for_backend_state 'single_after_queue_marker' 'Lock' 'advisory'
wait "$queue_first_pid"
wait "$single_after_queue_pid"
if [[ "$(cat "$TMP_ROOT/single-after-queue.code")" == "0" ]]; then
  echo "queue warning was accepted as single-report deletion" >&2
  cat "$TMP_ROOT/single-after-queue.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $queue_first_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000001'
      AND status = 'resolved'
      AND action_taken = 'user_warned'
  ) OR (SELECT deleted_at FROM public.posts
        WHERE id = '11000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'queue-first concurrency left partial state';
  END IF;
END
$queue_first_proof$;
SQL

# Single resolution wins the shared target lock. Queue waits and then sees no
# pending report, so the content/report/audit transaction commits only once.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/single-first-queue.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config(
  'test.pause_post_id',
  '11000000-0000-4000-8000-000000000002',
  false
);
SELECT /* single_first_queue_marker */ result_code
FROM public.resolve_content_report_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000002',
  'resolve',
  NULL
);
SQL
) &
single_first_queue_pid=$!
wait_for_backend_state 'single_first_queue_marker' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/queue-after-single.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT /* queue_after_single_marker */ public.test_queue_transition_with_target_lock(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '11000000-0000-4000-8000-000000000002',
  'delete'
);
SQL
) &
queue_after_single_pid=$!
wait_for_backend_state 'queue_after_single_marker' 'Lock' 'advisory'
wait "$single_first_queue_pid"
wait "$queue_after_single_pid"

psql_cmd <<'SQL'
DO $single_first_queue_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000002'
      AND status = 'resolved'
      AND action_taken = 'content_deleted'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '11000000-0000-4000-8000-000000000002'
      AND deleted_at IS NOT NULL
  ) OR (
    SELECT pg_catalog.count(*) FROM public.admin_logs
    WHERE target_id = '31000000-0000-4000-8000-000000000002'
  ) <> 1 THEN
    RAISE EXCEPTION 'single-first queue concurrency did not commit exactly once';
  END IF;
END
$single_first_queue_proof$;
SQL

# Submit wins the same target lock, inserts another reporter's row, then the
# single endpoint transitions only its bound report and leaves the new one.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/submit-first.log" 2>&1
SELECT /* submit_first_marker */ public.test_submit_report_with_target_lock(
  '31000000-0000-4000-8000-000000000004',
  'e1000000-0000-4000-8000-000000000002',
  'post',
  '11000000-0000-4000-8000-000000000003',
  true
);
SQL
) &
submit_first_pid=$!
wait_for_backend_state 'submit_first_marker' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/single-after-submit.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT /* single_after_submit_marker */ result_code
FROM public.resolve_content_report_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000003',
  'resolve',
  NULL
);
SQL
) &
single_after_submit_pid=$!
wait_for_backend_state 'single_after_submit_marker' 'Lock' 'advisory'
wait "$submit_first_pid"
wait "$single_after_submit_pid"

psql_cmd <<'SQL'
DO $submit_first_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000003'
      AND status = 'resolved'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000004'
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'submit-first concurrency lost or over-transitioned a report';
  END IF;
END
$submit_first_proof$;
SQL

# Single resolution wins first; submit waits and creates a new pending report
# only after the original report/content/audit transaction has committed.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/single-first-submit.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config(
  'test.pause_post_id',
  '11000000-0000-4000-8000-000000000004',
  false
);
SELECT /* single_first_submit_marker */ result_code
FROM public.resolve_content_report_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000005',
  'resolve',
  NULL
);
SQL
) &
single_first_submit_pid=$!
wait_for_backend_state 'single_first_submit_marker' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/submit-after-single.log" 2>&1
SELECT /* submit_after_single_marker */ public.test_submit_report_with_target_lock(
  '31000000-0000-4000-8000-000000000006',
  'e1000000-0000-4000-8000-000000000002',
  'post',
  '11000000-0000-4000-8000-000000000004',
  false
);
SQL
) &
submit_after_single_pid=$!
wait_for_backend_state 'submit_after_single_marker' 'Lock' 'advisory'
wait "$single_first_submit_pid"
wait "$submit_after_single_pid"

psql_cmd <<'SQL'
DO $single_first_submit_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000005'
      AND status = 'resolved'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000006'
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'single-first submit concurrency lost a report state';
  END IF;
END
$single_first_submit_proof$;
SQL

# Resolution first versus actor deletion: the RPC's actor auth SHARE lock makes
# deletion wait parent-first; both operations finish without deadlock.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/actor-resolution-first.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config(
  'test.pause_post_id',
  '11000000-0000-4000-8000-000000000005',
  false
);
SELECT /* actor_resolution_first_marker */ result_code
FROM public.resolve_content_report_atomic(
  'a1000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000007',
  'resolve',
  NULL
);
SQL
) &
actor_resolution_first_pid=$!
wait_for_backend_state 'actor_resolution_first_marker' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/actor-delete-second.log" 2>&1
DELETE FROM auth.users /* actor_delete_second_marker */
WHERE id = 'a1000000-0000-4000-8000-000000000001';
SQL
) &
actor_delete_second_pid=$!
wait_for_backend_state 'actor_delete_second_marker' 'Lock'
wait "$actor_resolution_first_pid"
wait "$actor_delete_second_pid"

psql_cmd <<'SQL'
DO $actor_resolution_first_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = 'a1000000-0000-4000-8000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000007'
      AND status = 'resolved'
      AND resolved_by IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '11000000-0000-4000-8000-000000000005'
      AND deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'resolution-first actor deletion left partial state';
  END IF;
END
$actor_resolution_first_proof$;
SQL

# Actor deletion first: resolver waits on auth.users, then fails before any
# profile/content/report child mutation after the actor disappears.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/actor-delete-first.log" 2>&1
SELECT pg_catalog.set_config(
  'test.pause_auth_id',
  'a1000000-0000-4000-8000-000000000002',
  false
);
DELETE FROM auth.users /* actor_delete_first_marker */
WHERE id = 'a1000000-0000-4000-8000-000000000002';
SQL
) &
actor_delete_first_pid=$!
wait_for_backend_state 'actor_delete_first_marker' 'Timeout' 'PgSleep'

(
  set +e
  psql_cmd -At <<'SQL' >"$TMP_ROOT/resolution-after-actor-delete.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT /* resolution_after_actor_delete_marker */ result_code
FROM public.resolve_content_report_atomic(
  'a1000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000008',
  'resolve',
  NULL
);
SQL
  echo "$?" >"$TMP_ROOT/resolution-after-actor-delete.code"
) &
resolution_after_actor_delete_pid=$!
wait_for_backend_state 'resolution_after_actor_delete_marker' 'Lock'
wait "$actor_delete_first_pid"
wait "$resolution_after_actor_delete_pid"
if [[ "$(cat "$TMP_ROOT/resolution-after-actor-delete.code")" == "0" ]]; then
  echo "resolution succeeded after actor deletion won" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $actor_delete_first_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000008'
      AND status = 'pending'
  ) OR (SELECT deleted_at FROM public.posts
        WHERE id = '11000000-0000-4000-8000-000000000006') IS NOT NULL THEN
    RAISE EXCEPTION 'actor-delete-first concurrency left partial state';
  END IF;
END
$actor_delete_first_proof$;
SQL

# Resolution first versus author deletion follows the same auth parent -> post
# child direction. The eventual cascade may remove the soft-deleted post, but
# the report transition remains complete and there is no lock cycle.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/author-resolution-first.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config(
  'test.pause_post_id',
  '11000000-0000-4000-8000-000000000007',
  false
);
SELECT /* author_resolution_first_marker */ result_code
FROM public.resolve_content_report_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000009',
  'resolve',
  NULL
);
SQL
) &
author_resolution_first_pid=$!
wait_for_backend_state 'author_resolution_first_marker' 'Timeout' 'PgSleep'

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/author-delete-second.log" 2>&1
DELETE FROM auth.users /* author_delete_second_marker */
WHERE id = 'b1000000-0000-4000-8000-000000000003';
SQL
) &
author_delete_second_pid=$!
wait_for_backend_state 'author_delete_second_marker' 'Lock'
wait "$author_resolution_first_pid"
wait "$author_delete_second_pid"

psql_cmd <<'SQL'
DO $author_resolution_first_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '11000000-0000-4000-8000-000000000007'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000009'
      AND status = 'resolved'
  ) THEN
    RAISE EXCEPTION 'resolution-first author deletion left partial report state';
  END IF;
END
$author_resolution_first_proof$;
SQL

# Author deletion first: resolver waits on the parent auth row, then fails with
# no report/audit transition after the author/post cascade commits.
(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/author-delete-first.log" 2>&1
SELECT pg_catalog.set_config(
  'test.pause_auth_id',
  'b1000000-0000-4000-8000-000000000004',
  false
);
DELETE FROM auth.users /* author_delete_first_marker */
WHERE id = 'b1000000-0000-4000-8000-000000000004';
SQL
) &
author_delete_first_pid=$!
wait_for_backend_state 'author_delete_first_marker' 'Timeout' 'PgSleep'

(
  set +e
  psql_cmd -At <<'SQL' >"$TMP_ROOT/resolution-after-author-delete.log" 2>&1
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT /* resolution_after_author_delete_marker */ result_code
FROM public.resolve_content_report_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000010',
  'resolve',
  NULL
);
SQL
  echo "$?" >"$TMP_ROOT/resolution-after-author-delete.code"
) &
resolution_after_author_delete_pid=$!
wait_for_backend_state 'resolution_after_author_delete_marker' 'Lock'
wait "$author_delete_first_pid"
wait "$resolution_after_author_delete_pid"
if [[ "$(cat "$TMP_ROOT/resolution-after-author-delete.code")" == "0" ]]; then
  echo "resolution succeeded after author deletion won" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $author_delete_first_proof$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = '11000000-0000-4000-8000-000000000008'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000010'
      AND status = 'pending'
  ) OR EXISTS (
    SELECT 1 FROM public.admin_logs
    WHERE target_id = '31000000-0000-4000-8000-000000000010'
  ) THEN
    RAISE EXCEPTION 'author-delete-first concurrency left partial state';
  END IF;
END
$author_delete_first_proof$;
SQL

echo "atomic single report resolution PG17 tests passed"
