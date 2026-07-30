#!/usr/bin/env bash

# PostgreSQL 17 proof for retry-safe ranking-notification batches. This owns an
# isolated cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729175500_atomic_ranking_notification_batch.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-ranking-notification-batch-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((63600 + ($$ % 1300)))
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

service_sql() {
  local sql=$1
  psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; $sql"
}

expect_failure() {
  local sql=$1
  if psql_cmd -c "$sql" >"$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "Expected SQL to fail: $sql" >&2
    return 1
  fi
}

assert_scalar() {
  local expected=$1
  local sql=$2
  local actual
  actual="$(psql_cmd -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected [$expected], received [$actual] for: $sql" >&2
    return 1
  fi
}

assert_service_scalar() {
  local expected=$1
  local sql=$2
  local actual
  actual="$(service_sql "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected [$expected], received [$actual] for service SQL: $sql" >&2
    return 1
  fi
}

wait_for_query() {
  local pattern=$1
  local attempts=0
  while ((attempts < 300)); do
    if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%${pattern}%' AND state = 'active')")" == "t" ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
  done
  echo "Timed out waiting for query pattern: $pattern" >&2
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
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c timezone=UTC" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_role NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
      ->> 'role'
  )::text
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE FUNCTION public.install_active_authenticated_subject_mutation_barriers()
RETURNS integer LANGUAGE sql AS $function$ SELECT 1 $function$;
CREATE FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
RETURNS integer LANGUAGE sql AS $function$ SELECT 1 $function$;
CREATE FUNCTION public.create_notification_atomic(
  uuid, text, text, text, text, uuid, text, boolean, integer
)
RETURNS jsonb LANGUAGE sql AS $function$ SELECT '{}'::jsonb $function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  read boolean DEFAULT false,
  read_at timestamptz,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reference_id text,
  created_at timestamptz DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT notifications_type_check CHECK (
    type IN ('ranking_change', 'system', 'follow')
  )
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO service_role;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
UPDATE public.user_profiles
SET deleted_at='2026-07-29T11:00:00Z'
WHERE id='33333333-3333-4333-8333-333333333333';

-- Legacy retries left two copies. Migration convergence keeps the newest.
INSERT INTO public.notifications(
  id, user_id, type, title, message, reference_id, created_at
) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
   '11111111-1111-4111-8111-111111111111', 'ranking_change',
   'old duplicate', 'body', 'legacy-duplicate', '2026-07-28T00:00:00Z'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
   '11111111-1111-4111-8111-111111111111', 'ranking_change',
   'new duplicate', 'body', 'legacy-duplicate', '2026-07-29T00:00:00Z');
SQL

psql_cmd -f "$MIGRATION" >/dev/null
assert_scalar '1|new duplicate' "SELECT count(*) || '|' || min(title) FROM public.notifications WHERE reference_id='legacy-duplicate'"
expect_failure "INSERT INTO public.notifications(user_id,type,title,message,reference_id) VALUES ('11111111-1111-4111-8111-111111111111','ranking_change','duplicate','body','legacy-duplicate')"

# Replay converges arbitrary function grants and service grant options.
psql_cmd <<'SQL'
GRANT EXECUTE
  ON FUNCTION public.create_ranking_notifications_batch_atomic(jsonb)
  TO authenticated, rogue_role;
GRANT EXECUTE
  ON FUNCTION public.create_ranking_notifications_batch_atomic(jsonb)
  TO service_role WITH GRANT OPTION;
SQL
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.create_ranking_notifications_batch_atomic('[]'::jsonb)"
expect_failure "SET ROLE rogue_role; SELECT public.create_ranking_notifications_batch_atomic('[]'::jsonb)"
assert_scalar 'true|false|false' "SELECT pg_catalog.has_function_privilege('service_role','public.create_ranking_notifications_batch_atomic(jsonb)','EXECUTE')::text || '|' || pg_catalog.has_function_privilege('authenticated','public.create_ranking_notifications_batch_atomic(jsonb)','EXECUTE')::text || '|' || COALESCE((SELECT acl_entry.is_grantable::text FROM pg_catalog.pg_proc AS function_row CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry WHERE function_row.oid='public.create_ranking_notifications_batch_atomic(jsonb)'::regprocedure AND acl_entry.grantee=pg_catalog.to_regrole('service_role')::oid),'false')"

assert_service_scalar 'INVALID' "SELECT public.create_ranking_notifications_batch_atomic('{}'::jsonb)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.create_ranking_notifications_batch_atomic('[]'::jsonb)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3','recipient_id','11111111-1111-4111-8111-111111111111','title','title','message','body','link','https://evil.example','reference_id','bad-link')))->>'reason'"
assert_service_scalar 'DUPLICATE_INPUT' "SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3','recipient_id','11111111-1111-4111-8111-111111111111','title','title','message','body','link',NULL,'reference_id','duplicate-input'),jsonb_build_object('request_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4','recipient_id','11111111-1111-4111-8111-111111111111','title','title','message','body','link',NULL,'reference_id','duplicate-input')))->>'reason'"

# One batch returns an exact, ordered partition: active rows are created while
# a deleted recipient is acknowledged without aborting the other recipients.
assert_service_scalar 'true|3|2|0|1|CREATED|RECIPIENT_UNAVAILABLE|CREATED|true|true' "WITH result AS (SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','10000000-0000-4000-8000-000000000001','recipient_id','11111111-1111-4111-8111-111111111111','title','Rank one','message','Now #1','link','/trader/one','reference_id','rank-batch-1'),jsonb_build_object('request_id','10000000-0000-4000-8000-000000000002','recipient_id','33333333-3333-4333-8333-333333333333','title','Rank gone','message','Now #2','link',NULL,'reference_id','rank-batch-gone'),jsonb_build_object('request_id','10000000-0000-4000-8000-000000000003','recipient_id','22222222-2222-4222-8222-222222222222','title','Rank two','message','Now #3','link','/trader/two','reference_id','rank-batch-2'))) AS r) SELECT (r->>'success') || '|' || (r->>'requested_count') || '|' || (r->>'created_count') || '|' || (r->>'deduplicated_count') || '|' || (r->>'skipped_count') || '|' || (r#>>'{results,0,outcome}') || '|' || (r#>>'{results,1,outcome}') || '|' || (r#>>'{results,2,outcome}') || '|' || ((r#>>'{results,0,notification_id}') IS NOT NULL)::text || '|' || ((r#>>'{results,1,notification_id}') IS NULL)::text FROM result"
assert_scalar '2' "SELECT count(*) FROM public.notifications WHERE reference_id LIKE 'rank-batch-%'"

# Exact retry is fully deduplicated and returns the original notification IDs.
assert_service_scalar '0|2|1|DEDUPLICATED|true' "WITH result AS (SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','20000000-0000-4000-8000-000000000001','recipient_id','11111111-1111-4111-8111-111111111111','title','Rank one','message','Now #1','link','/trader/one','reference_id','rank-batch-1'),jsonb_build_object('request_id','20000000-0000-4000-8000-000000000002','recipient_id','33333333-3333-4333-8333-333333333333','title','Rank gone','message','Now #2','link',NULL,'reference_id','rank-batch-gone'),jsonb_build_object('request_id','20000000-0000-4000-8000-000000000003','recipient_id','22222222-2222-4222-8222-222222222222','title','Rank two','message','Now #3','link','/trader/two','reference_id','rank-batch-2'))) AS r) SELECT (r->>'created_count') || '|' || (r->>'deduplicated_count') || '|' || (r->>'skipped_count') || '|' || (r#>>'{results,0,outcome}') || '|' || ((r#>>'{results,0,notification_id}')=(SELECT id::text FROM public.notifications WHERE reference_id='rank-batch-1'))::text FROM result"

# Reusing a stable reference with different visible content is rejected before
# another row in the same batch can be inserted.
assert_service_scalar 'IDENTITY_CONFLICT' "SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','30000000-0000-4000-8000-000000000001','recipient_id','11111111-1111-4111-8111-111111111111','title','Changed title','message','Now #1','link','/trader/one','reference_id','rank-batch-1'),jsonb_build_object('request_id','30000000-0000-4000-8000-000000000002','recipient_id','11111111-1111-4111-8111-111111111111','title','Must rollback','message','body','link',NULL,'reference_id','must-not-exist')))->>'reason'"
assert_scalar '0' "SELECT count(*) FROM public.notifications WHERE reference_id='must-not-exist'"

# Partial-chunk recovery: replaying the committed first chunk creates nothing;
# the later chunk still creates its previously missing identity.
assert_service_scalar '1' "SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','40000000-0000-4000-8000-000000000001','recipient_id','11111111-1111-4111-8111-111111111111','title','Chunk one','message','body','link',NULL,'reference_id','partial-1')))->>'created_count'"
assert_service_scalar '0' "SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','40000000-0000-4000-8000-000000000002','recipient_id','11111111-1111-4111-8111-111111111111','title','Chunk one','message','body','link',NULL,'reference_id','partial-1')))->>'created_count'"
assert_service_scalar '1' "SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','40000000-0000-4000-8000-000000000003','recipient_id','11111111-1111-4111-8111-111111111111','title','Chunk two','message','body','link',NULL,'reference_id','partial-2')))->>'created_count'"
assert_scalar '2' "SELECT count(*) FROM public.notifications WHERE reference_id LIKE 'partial-%'"

# Concurrent identical batches serialize and persist exactly one row.
psql_cmd -Atq >"$TMP_ROOT/batch-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.create_ranking_notifications_batch_atomic(
  jsonb_build_array(jsonb_build_object(
    'request_id','50000000-0000-4000-8000-000000000001',
    'recipient_id','44444444-4444-4444-8444-444444444444',
    'title','Race one',
    'message','body',
    'link',NULL,
    'reference_id','batch-race'
  ))
);
SELECT pg_catalog.pg_sleep(1) /* ranking_notification_batch_owner_hold */;
COMMIT;
SQL
batch_pid=$!
wait_for_query 'ranking_notification_batch_owner_hold'
assert_service_scalar '0|1' "WITH result AS (SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','50000000-0000-4000-8000-000000000002','recipient_id','44444444-4444-4444-8444-444444444444','title','Race one','message','body','link',NULL,'reference_id','batch-race'))) AS r) SELECT (r->>'created_count') || '|' || (r->>'deduplicated_count') FROM result" || { echo 'concurrent ranking notification batches were not deduplicated' >&2; exit 1; }
wait "$batch_pid"
assert_scalar '1' "SELECT count(*) FROM public.notifications WHERE reference_id='batch-race'"

# A committed account deletion wins admission before the batch can create.
psql_cmd >"$TMP_ROOT/lifecycle-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:22222222-2222-4222-8222-222222222222',
    0
  )
);
UPDATE public.user_profiles
SET deleted_at='2026-07-29T14:00:00Z'
WHERE id='22222222-2222-4222-8222-222222222222';
SELECT pg_catalog.pg_sleep(1) /* ranking_notification_batch_lifecycle_hold */;
COMMIT;
SQL
lifecycle_pid=$!
wait_for_query 'ranking_notification_batch_lifecycle_hold'
assert_service_scalar 'RECIPIENT_UNAVAILABLE|0' "WITH result AS (SELECT public.create_ranking_notifications_batch_atomic(jsonb_build_array(jsonb_build_object('request_id','60000000-0000-4000-8000-000000000001','recipient_id','22222222-2222-4222-8222-222222222222','title','Late','message','body','link',NULL,'reference_id','late-batch'))) AS r) SELECT (r#>>'{results,0,outcome}') || '|' || (r->>'created_count') FROM result" || { echo 'ranking notification batch bypassed lifecycle admission' >&2; exit 1; }
wait "$lifecycle_pid"
assert_scalar '0' "SELECT count(*) FROM public.notifications WHERE reference_id='late-batch'"

echo 'atomic ranking notification batch PostgreSQL 17 checks passed'
