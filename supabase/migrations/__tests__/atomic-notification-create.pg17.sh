#!/usr/bin/env bash

# PostgreSQL 17 proof for lifecycle-safe, atomically deduplicated notification
# creation. This owns an isolated cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729174500_atomic_notification_create.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-notification-create-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((63500 + ($$ % 1500)))
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
CREATE FUNCTION public.mutate_notifications_atomic(uuid, text, uuid[])
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
    type IN (
      'follow', 'like', 'reaction', 'comment', 'system', 'mention',
      'copy_trade', 'message', 'trader_alert', 'trader_alert_roi',
      'trader_alert_drawdown', 'trader_alert_score', 'trader_alert_pnl',
      'trader_alert_rank', 'post_reply', 'new_follower', 'group_update',
      'ranking_change', 'referral_reward', 'tip_received',
      'subscription_expiring', 'subscription_expired', 'nft_expired',
      'nft_pending', 'nft_minted'
    )
  )
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# Replay converges arbitrary function grants and service grant options.
psql_cmd <<'SQL'
GRANT EXECUTE
  ON FUNCTION public.create_notification_atomic(
    uuid, text, text, text, text, uuid, text, boolean, integer
  )
  TO authenticated, rogue_role;
GRANT EXECUTE
  ON FUNCTION public.create_notification_atomic(
    uuid, text, text, text, text, uuid, text, boolean, integer
  )
  TO service_role WITH GRANT OPTION;
SQL
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','title','message',NULL,NULL,NULL,false,0)"
expect_failure "SET ROLE rogue_role; SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','title','message',NULL,NULL,NULL,false,0)"
assert_scalar 'true|false|false' "SELECT pg_catalog.has_function_privilege('service_role','public.create_notification_atomic(uuid,text,text,text,text,uuid,text,boolean,integer)','EXECUTE')::text || '|' || pg_catalog.has_function_privilege('authenticated','public.create_notification_atomic(uuid,text,text,text,text,uuid,text,boolean,integer)','EXECUTE')::text || '|' || COALESCE((SELECT acl_entry.is_grantable::text FROM pg_catalog.pg_proc AS function_row CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry WHERE function_row.oid='public.create_notification_atomic(uuid,text,text,text,text,uuid,text,boolean,integer)'::regprocedure AND acl_entry.grantee=pg_catalog.to_regrole('service_role')::oid),'false')"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
UPDATE public.user_profiles
SET deleted_at='2026-07-29T11:00:00Z'
WHERE id='33333333-3333-4333-8333-333333333333';
SQL

assert_service_scalar 'INVALID' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','unknown','title','message',NULL,NULL,NULL,false,0)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','tip_received','title','message',NULL,NULL,'tip-1',true,3600)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system',' ','message',NULL,NULL,NULL,false,0)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','title','message','https://evil.example',NULL,NULL,false,0)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','title','message',NULL,NULL,NULL,true,3600)->>'reason'"
assert_service_scalar 'RECIPIENT_UNAVAILABLE' "SELECT public.create_notification_atomic('33333333-3333-4333-8333-333333333333','system','title','message',NULL,NULL,NULL,false,0)->>'reason'"
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','like','title','message',NULL,'33333333-3333-4333-8333-333333333333',NULL,false,0)->>'reason'"

# Self-events are acknowledged without persisting a notification.
assert_service_scalar 'SKIPPED_SELF|null|null' "SELECT (r->>'outcome') || '|' || (r->'notification_id')::text || '|' || (r->'created_at')::text FROM (SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','like','self title','self message','/post/1','11111111-1111-4111-8111-111111111111','self',true,3600) AS r) AS result"
assert_scalar '0' "SELECT count(*) FROM public.notifications"

# One exact request is echoed and persisted as an unread notification.
assert_service_scalar 'CREATED|11111111-1111-4111-8111-111111111111|like|Actor liked|Body|/post/1|22222222-2222-4222-8222-222222222222|post-1|true|3600|true|true' "SELECT (r->>'outcome') || '|' || (r->>'recipient_id') || '|' || (r->>'type') || '|' || (r->>'title') || '|' || (r->>'message') || '|' || (r->>'link') || '|' || (r->>'actor_id') || '|' || (r->>'reference_id') || '|' || (r->>'deduplicate') || '|' || (r->>'dedup_window_seconds') || '|' || (r->>'notification_id' IS NOT NULL)::text || '|' || (r->>'created_at' IS NOT NULL)::text FROM (SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','like','Actor liked','Body','/post/1','22222222-2222-4222-8222-222222222222','post-1',true,3600) AS r) AS result"
assert_scalar 'false|Actor liked|Body' "SELECT read::text || '|' || title || '|' || message FROM public.notifications WHERE reference_id='post-1'"

# A replay within the window returns the exact existing ID instead of racing
# a second insert, while still echoing the current caller's request binding.
assert_service_scalar 'DEDUPLICATED|true|Updated title' "SELECT (r->>'outcome') || '|' || ((r->>'notification_id')=(SELECT id::text FROM public.notifications WHERE reference_id='post-1'))::text || '|' || (r->>'title') FROM (SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','like','Updated title','Body','/post/1','22222222-2222-4222-8222-222222222222','post-1',true,3600) AS r) AS result"
assert_scalar '1|Actor liked' "SELECT count(*) || '|' || min(title) FROM public.notifications WHERE reference_id='post-1'"

# NULL-actor system notifications can opt into deduplication (the old helper
# incorrectly skipped dedup whenever actor_id was absent).
assert_service_scalar 'CREATED' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','subscription_expiring','Expiry','Renew soon','/settings',NULL,'subscription-1',true,259200)->>'outcome'"
assert_service_scalar 'DEDUPLICATED' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','subscription_expiring','Expiry','Renew soon','/settings',NULL,'subscription-1',true,259200)->>'outcome'"
assert_scalar '1' "SELECT count(*) FROM public.notifications WHERE reference_id='subscription-1'"

# A caller that explicitly disables dedup receives independent notifications.
assert_service_scalar 'CREATED' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','One','Body',NULL,NULL,'repeatable',false,0)->>'outcome'"
assert_service_scalar 'CREATED' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','Two','Body',NULL,NULL,'repeatable',false,0)->>'outcome'"
assert_scalar '2' "SELECT count(*) FROM public.notifications WHERE reference_id='repeatable'"

# A malformed future timestamp is not inside the caller's past-time window.
psql_cmd <<'SQL'
INSERT INTO public.notifications(
  user_id, type, title, message, reference_id, created_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'system',
  'Future row',
  'Body',
  'future-key',
  '2099-01-01T00:00:00Z'
);
SQL
assert_service_scalar 'CREATED' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','Current row','Body',NULL,NULL,'future-key',true,3600)->>'outcome'"
assert_scalar '2' "SELECT count(*) FROM public.notifications WHERE reference_id='future-key'"

# Concurrent callers sharing one identity serialize before lookup+insert. The
# second call returns the committed first row and the table contains one row.
psql_cmd -Atq >"$TMP_ROOT/create-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.create_notification_atomic(
  '11111111-1111-4111-8111-111111111111',
  'system',
  'Race one',
  'Body',
  NULL,
  NULL,
  'race-key',
  true,
  3600
);
SELECT pg_catalog.pg_sleep(1) /* notification_create_owner_hold */;
COMMIT;
SQL
create_pid=$!
wait_for_query 'notification_create_owner_hold'
assert_service_scalar 'DEDUPLICATED' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','Race two','Body',NULL,NULL,'race-key',true,3600)->>'outcome'" || { echo 'concurrent notification creates were not deduplicated' >&2; exit 1; }
wait "$create_pid"
assert_scalar '1' "SELECT count(*) FROM public.notifications WHERE reference_id='race-key'"

# Reciprocal actor/recipient pairs use one stable account-lock order and do not
# deadlock while the first transaction still owns both lifecycle locks.
psql_cmd -Atq >"$TMP_ROOT/reciprocal-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.create_notification_atomic(
  '11111111-1111-4111-8111-111111111111',
  'mention',
  'A mentions B',
  'Body',
  NULL,
  '22222222-2222-4222-8222-222222222222',
  'reciprocal-a',
  true,
  3600
);
SELECT pg_catalog.pg_sleep(1) /* notification_reciprocal_owner_hold */;
COMMIT;
SQL
reciprocal_pid=$!
wait_for_query 'notification_reciprocal_owner_hold'
assert_service_scalar 'CREATED' "SELECT public.create_notification_atomic('22222222-2222-4222-8222-222222222222','mention','B mentions A','Body',NULL,'11111111-1111-4111-8111-111111111111','reciprocal-b',true,3600)->>'outcome'" || { echo 'reciprocal notification lifecycle locks deadlocked' >&2; exit 1; }
wait "$reciprocal_pid"

# A committed account deletion wins admission before creation can persist.
psql_cmd >"$TMP_ROOT/lifecycle-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:11111111-1111-4111-8111-111111111111',
    0
  )
);
UPDATE public.user_profiles
SET deleted_at='2026-07-29T14:00:00Z'
WHERE id='11111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* notification_create_lifecycle_hold */;
COMMIT;
SQL
lifecycle_pid=$!
wait_for_query 'notification_create_lifecycle_hold'
assert_service_scalar 'RECIPIENT_UNAVAILABLE' "SELECT public.create_notification_atomic('11111111-1111-4111-8111-111111111111','system','Late','Body',NULL,NULL,NULL,false,0)->>'reason'" || { echo 'notification create bypassed lifecycle admission' >&2; exit 1; }
wait "$lifecycle_pid"
assert_scalar '0' "SELECT count(*) FROM public.notifications WHERE title='Late'"

echo 'atomic notification create PostgreSQL 17 checks passed'
