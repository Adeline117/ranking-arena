#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the V1 trader-alert browser/PostgREST
# containment boundary. It owns an isolated temporary cluster and never
# contacts an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260816130000_quarantine_v1_trader_alert_browser_mutations.sql"
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

TMP_ROOT="$(mktemp -d /tmp/v1-trader-alert-browser-boundary-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((56500 + ($$ % 1200)))}"
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
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

assert_query() {
  local expected="$1"
  local sql="$2"
  local label="$3"
  local actual
  actual="$(psql_cmd -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    return 1
  fi
}

expect_sql_failure() {
  local sql="$1"
  local needle="$2"
  local label="$3"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -c "$sql" >"$failure_log" 2>&1; then
    echo "Expected SQL failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing failure evidence '$needle': $label" >&2
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
    echo "Missing migration failure evidence '$needle': $label" >&2
    return 1
  fi
}

ALICE_ID='11111111-1111-4111-8111-111111111111'
BOB_ID='22222222-2222-4222-8222-222222222222'
ALICE_ALERT_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
BOB_ALERT_ID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
ALICE_HISTORY_ID='cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
SERVICE_ALERT_ID='dddddddd-dddd-4ddd-8ddd-ddddddddddd4'

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
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

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
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE TABLE public.trader_alerts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE public.alert_history (
  id uuid PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES public.trader_alerts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_type text NOT NULL
);

CREATE TABLE public.user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  watched_traders jsonb NOT NULL DEFAULT '[]'::jsonb,
  email_notifications boolean NOT NULL DEFAULT true,
  push_notifications boolean NOT NULL DEFAULT false,
  ranking_change_threshold integer NOT NULL DEFAULT 10
);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text NOT NULL,
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
  email_digest text NOT NULL DEFAULT 'none',
  settings_version integer,
  show_pro_badge boolean,
  last_seen_at timestamptz,
  is_online boolean,
  interests jsonb,
  onboarding_completed boolean,
  search_history jsonb
);

ALTER TABLE public.trader_alerts OWNER TO postgres;
ALTER TABLE public.alert_history OWNER TO postgres;
ALTER TABLE public.user_preferences OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Reproduce the broad historical table grants plus the later profile
-- column-grant model. The migration must remove both overlapping forms.
GRANT ALL PRIVILEGES ON TABLE
  public.trader_alerts,
  public.alert_history,
  public.user_preferences
TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_profiles
  TO PUBLIC, anon, authenticated, service_role;
GRANT UPDATE (
  handle,
  notify_trader_events,
  email_digest
) ON TABLE public.user_profiles TO authenticated;

ALTER TABLE public.trader_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own alerts"
  ON public.trader_alerts
  FOR ALL TO public
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can view own alert history"
  ON public.alert_history
  FOR SELECT TO public
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "System can insert alert history"
  ON public.alert_history
  FOR INSERT TO public
  WITH CHECK (true);

CREATE POLICY "Users can read own preferences"
  ON public.user_preferences
  FOR SELECT TO public
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own preferences"
  ON public.user_preferences
  FOR UPDATE TO public
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own preferences"
  ON public.user_preferences
  FOR INSERT TO public
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Service manage user_preferences"
  ON public.user_preferences
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY profile_authenticated_select
  ON public.user_profiles
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));
CREATE POLICY profile_authenticated_update
  ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY profile_service_mutation
  ON public.user_profiles
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

INSERT INTO public.trader_alerts (id, user_id, trader_id, enabled) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'alice-trader', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '22222222-2222-4222-8222-222222222222', 'bob-trader', true);
INSERT INTO public.alert_history (id, alert_id, user_id, alert_type) VALUES
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'roi_change');
INSERT INTO public.user_preferences (
  user_id,
  watched_traders,
  email_notifications,
  push_notifications,
  ranking_change_threshold
) VALUES
  ('11111111-1111-4111-8111-111111111111', '["alice-trader"]'::jsonb, true, true, 5),
  ('22222222-2222-4222-8222-222222222222', '["bob-trader"]'::jsonb, true, false, 10);
INSERT INTO public.user_profiles (id, handle, notify_trader_events, email_digest) VALUES
  ('11111111-1111-4111-8111-111111111111', 'alice', true, 'weekly'),
  ('22222222-2222-4222-8222-222222222222', 'bob', true, 'daily');
SQL

# A missing exact subscription column must abort before any policy/ACL rewrite.
psql_cmd -c 'ALTER TABLE public.user_preferences RENAME COLUMN watched_traders TO watched_traders_drift' >/dev/null
expect_migration_failure \
  'V1 trader-alert browser quarantine requires compatible columns' \
  'column-drift'
assert_query \
  't' \
  "SELECT pg_catalog.has_table_privilege('authenticated', 'public.trader_alerts', 'INSERT')" \
  'column-drift preflight did not revoke historical browser authority'
psql_cmd -c 'ALTER TABLE public.user_preferences RENAME COLUMN watched_traders_drift TO watched_traders' >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null

# Existing legacy values are preserved; their only product effect is disabled
# by the application/cron tombstones, not by a destructive preference rewrite.
assert_query \
  't|weekly|1' \
  "SELECT notify_trader_events, email_digest, (SELECT count(*) FROM public.trader_alerts WHERE id = '$ALICE_ALERT_ID') FROM public.user_profiles WHERE id = '$ALICE_ID'" \
  'legacy alert state preserved'

assert_query \
  '1|1|1' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; SELECT (SELECT count(*) FROM public.trader_alerts), (SELECT count(*) FROM public.alert_history), (SELECT count(*) FROM public.user_preferences)" \
  'owner legacy inventory remains readable'
assert_query \
  '0' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$BOB_ID'; SELECT count(*) FROM public.trader_alerts WHERE id = '$ALICE_ALERT_ID'" \
  'owner inventory remains scoped'

expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; INSERT INTO public.trader_alerts (id, user_id, trader_id, enabled) VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', '$ALICE_ID', 'browser-created', true)" \
  'permission denied' \
  'browser-trader-alert-insert'
expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; UPDATE public.trader_alerts SET enabled = true WHERE id = '$ALICE_ALERT_ID'" \
  'permission denied' \
  'browser-trader-alert-reenable'
expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; INSERT INTO public.alert_history (id, alert_id, user_id, alert_type) VALUES ('ffffffff-ffff-4fff-8fff-fffffffffff6', '$ALICE_ALERT_ID', '$ALICE_ID', 'forged')" \
  'permission denied' \
  'browser-alert-history-insert'
expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; UPDATE public.alert_history SET alert_type = 'forged' WHERE id = '$ALICE_HISTORY_ID'" \
  'permission denied' \
  'browser-alert-history-update'
expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; UPDATE public.user_preferences SET ranking_change_threshold = 1 WHERE user_id = '$ALICE_ID'" \
  'permission denied' \
  'browser-ranking-threshold-update'
expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; INSERT INTO public.user_preferences (user_id, watched_traders) VALUES ('33333333-3333-4333-8333-333333333333', '[\"browser-trader\"]'::jsonb)" \
  'permission denied' \
  'browser-ranking-subscription-insert'
expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; UPDATE public.user_profiles SET notify_trader_events = true WHERE id = '$ALICE_ID'" \
  'permission denied' \
  'browser-trader-event-opt-in'
expect_sql_failure \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; UPDATE public.user_profiles SET email_digest = 'weekly' WHERE id = '$ALICE_ID'" \
  'permission denied' \
  'browser-digest-opt-in'
assert_query \
  "$ALICE_ID" \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; UPDATE public.user_profiles SET handle = 'alice-safe-profile-edit' WHERE id = '$ALICE_ID' RETURNING id" \
  'unrelated safe profile update remains available'

# Owner deletion remains available for cleanup and cascades its own legacy
# history, without granting direct history deletes/inserts to the browser.
assert_query \
  "$ALICE_ALERT_ID" \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; DELETE FROM public.trader_alerts WHERE id = '$ALICE_ALERT_ID' RETURNING id" \
  'owner legacy alert delete remains available'
assert_query \
  '0' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '$ALICE_ID'; SELECT count(*) FROM public.alert_history WHERE id = '$ALICE_HISTORY_ID'" \
  'owner alert delete preserves FK cleanup semantics'

# Server-gated writes and exports remain possible with service credentials.
assert_query \
  '1' \
  "SET ROLE service_role; INSERT INTO public.trader_alerts (id, user_id, trader_id, enabled) VALUES ('$SERVICE_ALERT_ID', '$ALICE_ID', 'service-legacy-row', false); SELECT count(*) FROM public.trader_alerts WHERE id = '$SERVICE_ALERT_ID'" \
  'service legacy alert access remains available'
assert_query \
  'f|none' \
  "SET ROLE service_role; UPDATE public.user_profiles SET notify_trader_events = false, email_digest = 'none' WHERE id = '$ALICE_ID'; SELECT notify_trader_events, email_digest FROM public.user_profiles WHERE id = '$ALICE_ID'" \
  'server-gated notification opt-out remains available'
expect_sql_failure \
  'SET ROLE anon; SELECT * FROM public.trader_alerts' \
  'permission denied' \
  'anon-legacy-alert-read'

# A replay must converge a later accidental table/column grant and additive
# policy back to the V1 boundary.
psql_cmd <<SQL
GRANT INSERT, UPDATE ON TABLE public.trader_alerts TO authenticated;
GRANT UPDATE (notify_trader_events, email_digest)
  ON TABLE public.user_profiles TO authenticated;
CREATE POLICY rogue_trader_alert_writer
  ON public.trader_alerts
  FOR INSERT TO authenticated
  WITH CHECK (true);
SQL
psql_cmd -f "$MIGRATION" >/dev/null

assert_query \
  'f|f|f|f|3|2|2' \
  "SELECT pg_catalog.has_table_privilege('authenticated', 'public.trader_alerts', 'INSERT'), pg_catalog.has_table_privilege('authenticated', 'public.trader_alerts', 'UPDATE'), pg_catalog.has_column_privilege('authenticated', 'public.user_profiles', 'notify_trader_events', 'UPDATE'), pg_catalog.has_column_privilege('authenticated', 'public.user_profiles', 'email_digest', 'UPDATE'), (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'public.trader_alerts'::regclass), (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'public.alert_history'::regclass), (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'public.user_preferences'::regclass)" \
  'replay converges direct browser grants and policy drift'

echo 'V1 trader-alert browser mutation containment PostgreSQL 17 proof passed'
