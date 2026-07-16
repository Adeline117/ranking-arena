#!/usr/bin/env bash

# PostgreSQL 17 proof for permanent moderation operation IDs, exact legacy
# audit evidence, retired four-argument execution, and opposing-profile locks.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716160000_report_moderation_operation_id.sql"
PREDECESSOR="$ROOT_DIR/supabase/migrations/20260716154731_atomic_report_moderation_queue.sql"
BASELINE="$ROOT_DIR/supabase/migrations/20260716113800_private_report_evidence_storage.sql"
PREDECESSOR_TEST="$ROOT_DIR/supabase/migrations/__tests__/atomic-report-moderation-queue.pg17.sh"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/report-moderation-operation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55634
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

expect_migration_replay_failure() {
  local label="$1"
  local status

  set +e
  psql_cmd -f "$MIGRATION" >"$TMP_ROOT/replay-${label}.out" 2>&1
  status=$?
  set -e

  if ((status == 0)); then
    echo "migration replay accepted ledger drift: ${label}" >&2
    exit 1
  fi
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

# Reuse the predecessor's exact compact schema fixture, then exercise both
# real predecessor migrations rather than copying their function bodies.
sed -n '90,370p' "$PREDECESSOR_TEST" | psql_cmd >/dev/null
sed -n '1724,2061p' "$BASELINE" | psql_cmd >/dev/null
psql_cmd -f "$PREDECESSOR" >/dev/null

psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

INSERT INTO public.user_profiles(id, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'user'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'user');

INSERT INTO public.posts(id, author_id) VALUES
  ('11000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('11000000-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('11000000-0000-4000-8000-000000000003', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('11000000-0000-4000-8000-000000000004', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('11000000-0000-4000-8000-000000000005', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('11000000-0000-4000-8000-000000000006', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('11000000-0000-4000-8000-000000000007', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('11000000-0000-4000-8000-000000000009', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

INSERT INTO public.content_reports(
  id, reporter_id, content_type, content_id
) VALUES
  ('31000000-0000-4000-8000-000000000001', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '11000000-0000-4000-8000-000000000001'),
  ('31000000-0000-4000-8000-000000000004', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '11000000-0000-4000-8000-000000000004'),
  ('31000000-0000-4000-8000-000000000005', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'post', '11000000-0000-4000-8000-000000000005'),
  ('31000000-0000-4000-8000-000000000006', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'post', '11000000-0000-4000-8000-000000000006');

-- Produce one genuine predecessor audit/batch for legacy adoption.
DO $legacy_atomic_action$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '11000000-0000-4000-8000-000000000001',
    'approve'
  );
  IF NOT v_result.applied THEN
    RAISE EXCEPTION 'predecessor failed to produce genuine legacy evidence';
  END IF;
END
$legacy_atomic_action$;

-- A canonical-looking report row without the matching atomic audit is forged.
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
  '31000000-0000-4000-8000-000000000002',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '11000000-0000-4000-8000-000000000002',
  'dismissed',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '2026-07-16T12:00:00Z',
  'approved_content'
);

-- Even an exact audit cannot make content_deleted true while the row is active.
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
  '31000000-0000-4000-8000-000000000003',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '11000000-0000-4000-8000-000000000003',
  'resolved',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '2026-07-16T12:01:00Z',
  'content_deleted'
);

INSERT INTO public.admin_logs(
  admin_id,
  action,
  target_type,
  target_id,
  details
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'delete_content',
  'post',
  '11000000-0000-4000-8000-000000000003',
  pg_catalog.jsonb_build_object(
    'content_type', 'post',
    'content_id', '11000000-0000-4000-8000-000000000003'::uuid,
    'report_count', 1,
    'report_ids', pg_catalog.to_jsonb(
      ARRAY['31000000-0000-4000-8000-000000000003'::uuid]
    ),
    'report_status', 'resolved',
    'action_taken', 'content_deleted',
    'author_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    'content_affected_count', 1,
    'strike_id', NULL::uuid,
    'strike_type', NULL::text
  )
);

-- A warn audit must reference a real strike with the exact user/issuer/type.
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
  '31000000-0000-4000-8000-000000000007',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '11000000-0000-4000-8000-000000000007',
  'resolved',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '2026-07-16T12:02:00Z',
  'user_warned'
);

INSERT INTO public.admin_logs(
  admin_id,
  action,
  target_type,
  target_id,
  details
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'issue_warning',
  'user',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  pg_catalog.jsonb_build_object(
    'content_type', 'post',
    'content_id', '11000000-0000-4000-8000-000000000007'::uuid,
    'report_count', 1,
    'report_ids', pg_catalog.to_jsonb(
      ARRAY['31000000-0000-4000-8000-000000000007'::uuid]
    ),
    'report_status', 'resolved',
    'action_taken', 'user_warned',
    'author_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    'content_affected_count', 0,
    'strike_id', '71000000-0000-4000-8000-000000000007'::uuid,
    'strike_type', 'warning'
  )
);

-- A historic ban cannot be adopted while its reported content is still active.
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
  '31000000-0000-4000-8000-000000000009',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'post',
  '11000000-0000-4000-8000-000000000009',
  'resolved',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '2026-07-16T12:03:00Z',
  'user_banned'
);

INSERT INTO public.admin_logs(
  admin_id,
  action,
  target_type,
  target_id,
  details
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'ban_user_from_queue',
  'user',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  pg_catalog.jsonb_build_object(
    'content_type', 'post',
    'content_id', '11000000-0000-4000-8000-000000000009'::uuid,
    'report_count', 1,
    'report_ids', pg_catalog.to_jsonb(
      ARRAY['31000000-0000-4000-8000-000000000009'::uuid]
    ),
    'report_status', 'resolved',
    'action_taken', 'user_banned',
    'author_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    'content_affected_count', 1,
    'strike_id', NULL::uuid,
    'strike_type', NULL::text
  )
);
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $signature_acl_proof$
DECLARE
  v_new regprocedure :=
    'public.moderate_report_queue_atomic(uuid,text,uuid,text,uuid)'::regprocedure;
  v_internal regprocedure :=
    'public.moderate_report_queue_atomic_v1_internal(uuid,text,uuid,text)'::regprocedure;
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.moderate_report_queue_atomic(uuid,text,uuid,text)'
     ) IS NOT NULL
     OR NOT pg_catalog.has_function_privilege('service_role', v_new, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_new, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_new, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_internal, 'EXECUTE')
     OR pg_catalog.has_table_privilege(
       'service_role',
       'public.report_moderation_operations',
       'SELECT'
     )
  THEN
    RAISE EXCEPTION 'operation-id signature or direct-access boundary drifted';
  END IF;
END
$signature_acl_proof$;

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $legacy_adoption_proof$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '11000000-0000-4000-8000-000000000001',
    'approve',
    '91000000-0000-4000-8000-000000000001'
  );
  IF v_result.applied
     OR v_result.result_operation_id <>
       '91000000-0000-4000-8000-000000000001'
     OR v_result.report_count <> 1
     OR v_result.action_taken <> 'approved_content'
  THEN
    RAISE EXCEPTION 'genuine legacy adoption acknowledgement is invalid: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.report_moderation_operations
    WHERE operation_id = '91000000-0000-4000-8000-000000000001'
      AND NOT initial_applied
      AND report_ids = ARRAY[
        '31000000-0000-4000-8000-000000000001'::uuid
      ]
  ) THEN
    RAISE EXCEPTION 'first-time legacy no-op was not persisted';
  END IF;

  INSERT INTO public.content_reports(
    id, reporter_id, content_type, content_id
  ) VALUES (
    '31000000-0000-4000-8000-000000000011',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'post',
    '11000000-0000-4000-8000-000000000001'
  );

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '11000000-0000-4000-8000-000000000001',
    'approve',
    '91000000-0000-4000-8000-000000000001'
  );
  IF v_result.applied OR v_result.report_count <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000011'
      AND status = 'pending'
  ) <> 1 THEN
    RAISE EXCEPTION 'same operation observed or consumed later pending work';
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '11000000-0000-4000-8000-000000000001',
    'approve',
    '91000000-0000-4000-8000-000000000002'
  );
  IF NOT v_result.applied OR v_result.report_count <> 1 OR (
    SELECT status
    FROM public.content_reports
    WHERE id = '31000000-0000-4000-8000-000000000011'
  ) <> 'dismissed' THEN
    RAISE EXCEPTION 'new operation did not process the later pending batch';
  END IF;
END
$legacy_adoption_proof$;

DO $forgery_rejection_proof$
BEGIN
  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '11000000-0000-4000-8000-000000000002',
      'approve',
      '91000000-0000-4000-8000-000000000003'
    );
    RAISE EXCEPTION 'forged report rows without audit were accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '11000000-0000-4000-8000-000000000003',
      'delete',
      '91000000-0000-4000-8000-000000000004'
    );
    RAISE EXCEPTION 'active content accepted a forged content_deleted replay';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '11000000-0000-4000-8000-000000000007',
      'warn',
      '91000000-0000-4000-8000-000000000017'
    );
    RAISE EXCEPTION 'warn audit without a real strike row was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '11000000-0000-4000-8000-000000000009',
      'ban',
      '91000000-0000-4000-8000-000000000019'
    );
    RAISE EXCEPTION 'active content accepted a forged user_banned replay';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  IF EXISTS (
    SELECT 1
    FROM public.report_moderation_operations
    WHERE operation_id IN (
      '91000000-0000-4000-8000-000000000003',
      '91000000-0000-4000-8000-000000000004',
      '91000000-0000-4000-8000-000000000017',
      '91000000-0000-4000-8000-000000000019'
    )
  ) OR (
    SELECT deleted_at
    FROM public.posts
    WHERE id = '11000000-0000-4000-8000-000000000003'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'forgery rejection left a ledger or content side effect';
  END IF;
END
$forgery_rejection_proof$;

DO $permanent_warn_replay_proof$
DECLARE
  v_first_strike_id uuid;
  v_result record;
  v_strikes integer;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '11000000-0000-4000-8000-000000000004',
    'warn',
    '91000000-0000-4000-8000-000000000005'
  );
  IF NOT v_result.applied
     OR v_result.strike_id IS NULL
     OR v_result.strike_type <> 'warning'
  THEN
    RAISE EXCEPTION 'first warning acknowledgement is invalid: %', v_result;
  END IF;
  v_first_strike_id := v_result.strike_id;

  INSERT INTO public.content_reports(
    id, reporter_id, content_type, content_id
  ) VALUES (
    '31000000-0000-4000-8000-000000000014',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'post',
    '11000000-0000-4000-8000-000000000004'
  );

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '11000000-0000-4000-8000-000000000004',
    'warn',
    '91000000-0000-4000-8000-000000000005'
  );
  SELECT pg_catalog.count(*)::integer
  INTO v_strikes
  FROM public.user_strikes
  WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  IF NOT v_result.applied
     OR v_result.strike_id IS DISTINCT FROM v_first_strike_id
     OR v_result.strike_type IS DISTINCT FROM 'warning'
     OR v_strikes <> 1
     OR (
       SELECT status
       FROM public.content_reports
       WHERE id = '31000000-0000-4000-8000-000000000014'
     ) <> 'pending'
  THEN
    RAISE EXCEPTION 'same warning operation did not replay its exact result';
  END IF;

  SELECT * INTO STRICT v_result
  FROM public.moderate_report_queue_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    '11000000-0000-4000-8000-000000000004',
    'warn',
    '91000000-0000-4000-8000-000000000006'
  );
  SELECT pg_catalog.count(*)::integer
  INTO v_strikes
  FROM public.user_strikes
  WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  IF NOT v_result.applied OR v_strikes <> 2 THEN
    RAISE EXCEPTION 'new warning operation did not process later pending work';
  END IF;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '11000000-0000-4000-8000-000000000004',
      'ban',
      '91000000-0000-4000-8000-000000000005'
    );
    RAISE EXCEPTION 'operation/action collision was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'post',
      '11000000-0000-4000-8000-000000000004',
      'warn',
      '91000000-0000-4000-8000-000000000005'
    );
    RAISE EXCEPTION 'operation/actor collision was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.moderate_report_queue_atomic(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'post',
      '11000000-0000-4000-8000-000000000005',
      'warn',
      '91000000-0000-4000-8000-000000000005'
    );
    RAISE EXCEPTION 'operation/target collision was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
END
$permanent_warn_replay_proof$;
SQL

# A relation-lock gate releases both opposing sanctions together. A one-second
# strike trigger keeps the winner's sorted profile locks held long enough to
# prove that the loser waits rather than forming the former A<->B deadlock.
psql_cmd <<'SQL'
CREATE TABLE public.report_profile_lock_barrier(id integer PRIMARY KEY);

CREATE FUNCTION public.test_hold_profile_locks_on_strike()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_catalog.pg_sleep(1);
  RETURN NEW;
END
$$;

CREATE TRIGGER test_hold_profile_locks_on_strike
BEFORE INSERT ON public.user_strikes
FOR EACH ROW EXECUTE FUNCTION public.test_hold_profile_locks_on_strike();
SQL

psql_cmd -c "BEGIN; LOCK TABLE public.report_profile_lock_barrier IN ACCESS EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(20) /* profile-order-gate-holder */; COMMIT;" \
  >"$TMP_ROOT/gate.out" 2>"$TMP_ROOT/gate.err" &
gate_pid=$!
wait_for_backend_state 'profile-order-gate-holder' 'Timeout' 'PgSleep'

psql_cmd <<'SQL' >"$TMP_ROOT/a-to-b.out" 2>"$TMP_ROOT/a-to-b.err" &
BEGIN;
LOCK TABLE public.report_profile_lock_barrier IN ACCESS SHARE MODE /* opposing-a-to-b-gate */;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT * FROM public.moderate_report_queue_atomic(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'post',
  '11000000-0000-4000-8000-000000000005',
  'warn',
  '91000000-0000-4000-8000-000000000007'
);
COMMIT;
SQL
a_to_b_pid=$!

psql_cmd <<'SQL' >"$TMP_ROOT/b-to-a.out" 2>"$TMP_ROOT/b-to-a.err" &
BEGIN;
LOCK TABLE public.report_profile_lock_barrier IN ACCESS SHARE MODE /* opposing-b-to-a-gate */;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT * FROM public.moderate_report_queue_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'post',
  '11000000-0000-4000-8000-000000000006',
  'warn',
  '91000000-0000-4000-8000-000000000008'
);
COMMIT;
SQL
b_to_a_pid=$!

wait_for_backend_state 'opposing-a-to-b-gate' 'Lock'
wait_for_backend_state 'opposing-b-to-a-gate' 'Lock'
psql_cmd -Atc "
  SELECT pg_catalog.pg_terminate_backend(pid)
  FROM pg_catalog.pg_stat_activity
  WHERE pid <> pg_catalog.pg_backend_pid()
    AND query LIKE '%profile-order-gate-holder%'
    AND wait_event = 'PgSleep'
" >/dev/null
wait "$gate_pid" || true
wait_for_backend_state 'moderate_report_queue_atomic' 'Lock'

set +e
wait "$a_to_b_pid"
a_to_b_status=$?
wait "$b_to_a_pid"
b_to_a_status=$?
set -e

if ((a_to_b_status != 0 || b_to_a_status != 0)); then
  cat "$TMP_ROOT/a-to-b.err" "$TMP_ROOT/b-to-a.err" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $opposing_profile_lock_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.report_moderation_operations
    WHERE operation_id IN (
      '91000000-0000-4000-8000-000000000007',
      '91000000-0000-4000-8000-000000000008'
    )
      AND initial_applied
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM public.user_strikes
    WHERE (user_id, issued_by) IN (
      (
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
      ),
      (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
      )
    )
  ) <> 2 THEN
    RAISE EXCEPTION 'opposing sanctions did not each commit exactly once';
  END IF;
END
$opposing_profile_lock_proof$;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# Replay preflight must reject same-column-count drift and every authority
# inventory surface before CREATE OR REPLACE or any other mutation runs.
psql_cmd -c "ALTER TABLE public.report_moderation_operations RENAME COLUMN actor_id TO actor_key" >/dev/null
expect_migration_replay_failure 'column-name'
psql_cmd -c "ALTER TABLE public.report_moderation_operations RENAME COLUMN actor_key TO actor_id" >/dev/null

psql_cmd -c "ALTER TABLE public.report_moderation_operations ALTER COLUMN created_at SET DEFAULT pg_catalog.statement_timestamp()" >/dev/null
expect_migration_replay_failure 'column-default'
psql_cmd -c "ALTER TABLE public.report_moderation_operations ALTER COLUMN created_at SET DEFAULT pg_catalog.clock_timestamp()" >/dev/null

psql_cmd -c "ALTER TABLE public.report_moderation_operations DROP CONSTRAINT report_moderation_operations_action_check, ADD CONSTRAINT report_moderation_operations_action_check CHECK (action IN ('approve', 'delete', 'warn', 'ban', 'forged'))" >/dev/null
expect_migration_replay_failure 'check-expression'
psql_cmd -c "ALTER TABLE public.report_moderation_operations DROP CONSTRAINT report_moderation_operations_action_check, ADD CONSTRAINT report_moderation_operations_action_check CHECK (action IN ('approve', 'delete', 'warn', 'ban'))" >/dev/null

psql_cmd -c "CREATE INDEX report_moderation_operations_forged_idx ON public.report_moderation_operations(actor_id)" >/dev/null
expect_migration_replay_failure 'index-inventory'
psql_cmd -c "DROP INDEX public.report_moderation_operations_forged_idx" >/dev/null

psql_cmd -c "CREATE POLICY report_moderation_operations_forged_policy ON public.report_moderation_operations FOR SELECT USING (true)" >/dev/null
expect_migration_replay_failure 'policy-inventory'
psql_cmd -c "DROP POLICY report_moderation_operations_forged_policy ON public.report_moderation_operations" >/dev/null

psql_cmd <<'SQL' >/dev/null
CREATE FUNCTION public.report_moderation_operations_forged_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END
$$;
CREATE TRIGGER report_moderation_operations_forged_trigger
BEFORE INSERT ON public.report_moderation_operations
FOR EACH ROW EXECUTE FUNCTION public.report_moderation_operations_forged_trigger();
SQL
expect_migration_replay_failure 'trigger-inventory'
psql_cmd -c "DROP TRIGGER report_moderation_operations_forged_trigger ON public.report_moderation_operations; DROP FUNCTION public.report_moderation_operations_forged_trigger()" >/dev/null

psql_cmd -c "ALTER TABLE public.report_moderation_operations DISABLE ROW LEVEL SECURITY" >/dev/null
expect_migration_replay_failure 'rls-state'
psql_cmd -c "ALTER TABLE public.report_moderation_operations ENABLE ROW LEVEL SECURITY" >/dev/null

psql_cmd -c "GRANT SELECT ON TABLE public.report_moderation_operations TO service_role" >/dev/null
expect_migration_replay_failure 'table-acl'
psql_cmd -c "REVOKE ALL ON TABLE public.report_moderation_operations FROM service_role" >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null

echo "report moderation operation-id PG17 tests passed"
