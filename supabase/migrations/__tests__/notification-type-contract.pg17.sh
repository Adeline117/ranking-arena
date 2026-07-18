#!/usr/bin/env bash

# PostgreSQL 17 proof for the application/database notification type contract.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260717222500_notification_type_contract.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/postgres --version)" != postgres\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/notification-type-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((56750 + RANDOM % 300))
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

expect_constraint_failure() {
  local sql="$1"
  local label="$2"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "Expected CHECK failure: $label" >&2
    return 1
  fi
  if ! grep -Fq '23514' "$failure_log" ||
     ! grep -Fq 'notifications_type_check' "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing notification CHECK evidence: $label" >&2
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
CREATE ROLE postgres NOLOGIN;
CREATE ROLE hostile_owner NOLOGIN;

CREATE TABLE public.notifications (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL
);
ALTER TABLE public.notifications OWNER TO postgres;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check CHECK (
    type IN (
      'follow', 'like', 'comment', 'system', 'mention', 'message',
      'copy_trade', 'trader_alert', 'trader_alert_roi', 'trader_alert_pnl',
      'trader_alert_score', 'trader_alert_rank', 'trader_alert_drawdown',
      'post_reply', 'new_follower', 'group_update', 'ranking_change',
      'referral_reward', 'tip_received', 'subscription_expiring',
      'subscription_expired', 'nft_expired'
    )
  );
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_nonempty
  CHECK (pg_catalog.length(type) > 0);
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_composite
  CHECK (type <> 'system' OR id > 0);
INSERT INTO public.notifications (type) VALUES ('system'), ('nft_expired');
SQL

expect_constraint_failure \
  "INSERT INTO public.notifications(type) VALUES ('reaction')" \
  "legacy-reaction-rejected"

# Owner drift aborts before touching the two historical type-only constraints.
psql_cmd -c \
  'ALTER TABLE public.notifications OWNER TO hostile_owner' >/dev/null
expect_migration_failure \
  "public.notifications must be a postgres-owned table" \
  "owner-drift"
assert_query \
  "2" \
  "SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND contype = 'c' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.notifications'::regclass AND attname = 'type')]::smallint[]" \
  "owner drift preserved legacy checks"
psql_cmd -c \
  'ALTER TABLE public.notifications OWNER TO postgres' >/dev/null

# If a dashboard/manual write persisted an unknown value while the old CHECK
# was absent, the migration must not guess a replacement classification.
psql_cmd <<'SQL' >/dev/null
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_type_check;
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_type_nonempty;
INSERT INTO public.notifications (type) VALUES ('mystery_type');
SQL
expect_migration_failure \
  "unknown persisted notification types must be classified first" \
  "unknown-history"
assert_query \
  "1" \
  "SELECT count(*) FROM public.notifications WHERE type = 'mystery_type'" \
  "unknown history failure preserved row"
psql_cmd <<'SQL' >/dev/null
DELETE FROM public.notifications WHERE type = 'mystery_type';
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('system', 'nft_expired'));
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_nonempty
  CHECK (pg_catalog.length(type) > 0);
SQL

psql_cmd -f "$MIGRATION" >/dev/null

assert_query \
  "1|1|4202c98e274ce25029f78eefd1beedcd" \
  "SELECT count(*) FILTER (WHERE conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.notifications'::regclass AND attname = 'type')]::smallint[]), count(*) FILTER (WHERE conname = 'notifications_type_composite'), max(pg_catalog.md5(pg_catalog.pg_get_expr(conbin, conrelid))) FILTER (WHERE conname = 'notifications_type_check') FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND contype = 'c'" \
  "canonical type check and composite check"

psql_cmd <<'SQL' >/dev/null
INSERT INTO public.notifications (type)
SELECT allowed_type
FROM pg_catalog.unnest(ARRAY[
  'follow', 'like', 'reaction', 'comment', 'system', 'mention',
  'copy_trade', 'message', 'trader_alert', 'trader_alert_roi',
  'trader_alert_drawdown', 'trader_alert_score', 'trader_alert_pnl',
  'trader_alert_rank', 'post_reply', 'new_follower', 'group_update',
  'ranking_change', 'referral_reward', 'tip_received',
  'subscription_expiring', 'subscription_expired', 'nft_expired',
  'nft_pending', 'nft_minted'
]::text[]) AS allowed_type;
SQL
assert_query \
  "25" \
  "SELECT count(DISTINCT type) FROM public.notifications" \
  "all application notification types persist"
expect_constraint_failure \
  "INSERT INTO public.notifications(type) VALUES ('unknown_future_type')" \
  "unknown-runtime-type-rejected"

# Simulate later dashboard drift with two stale single-column CHECKs. Replay
# must replace both while preserving the composite integrity constraint.
psql_cmd <<'SQL' >/dev/null
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('system')) NOT VALID;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_reaction_rejected
  CHECK (type <> 'reaction') NOT VALID;
SQL
psql_cmd -f "$MIGRATION" >/dev/null

assert_query \
  "1|1|t|4202c98e274ce25029f78eefd1beedcd" \
  "SELECT count(*) FILTER (WHERE contype = 'c' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.notifications'::regclass AND attname = 'type')]::smallint[]), count(*) FILTER (WHERE conname = 'notifications_type_composite'), bool_and(convalidated) FILTER (WHERE conname = 'notifications_type_check'), max(pg_catalog.md5(pg_catalog.pg_get_expr(conbin, conrelid))) FILTER (WHERE conname = 'notifications_type_check') FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass" \
  "replay converges notification type contract"
assert_query \
  "reaction" \
  "INSERT INTO public.notifications(type) VALUES ('reaction') RETURNING type" \
  "reaction remains writable after replay"

echo "Notification type contract PostgreSQL 17 proof passed"
