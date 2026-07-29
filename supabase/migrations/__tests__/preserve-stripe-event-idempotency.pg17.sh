#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729075550_preserve_stripe_event_idempotency.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/preserve-stripe-event-idempotency-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55594
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

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -c "$sql" >"$TMP_ROOT/$label.log" 2>&1; then
    echo "Expected failure: $label" >&2
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN;

GRANT USAGE ON SCHEMA public TO service_role;
CREATE TABLE public.stripe_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL,
  event_type text NOT NULL,
  livemode boolean NOT NULL,
  status text NOT NULL,
  processed_at timestamptz,
  UNIQUE (event_id, livemode)
);
ALTER TABLE public.stripe_events OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stripe_events TO service_role;

INSERT INTO public.stripe_events (
  event_id, event_type, livemode, status, processed_at
) VALUES (
  'evt_retained', 'invoice.paid', true, 'processed', now() - interval '31 days'
);

CREATE FUNCTION public.cleanup_old_stripe_events()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM public.stripe_events
  WHERE processed_at < now() - interval '30 days';
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_cleanup_stripe_events
  AFTER INSERT ON public.stripe_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.cleanup_old_stripe_events();
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
INSERT INTO public.stripe_events (
  event_id, event_type, livemode, status, processed_at
) VALUES (
  'evt_new', 'invoice.paid', true, 'processed', now()
);

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_events WHERE event_id = 'evt_retained'
  ) THEN
    RAISE EXCEPTION 'historical Stripe event was deleted';
  END IF;

  IF pg_catalog.to_regprocedure(
      'public.cleanup_old_stripe_events()'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'legacy Stripe cleanup function survived';
  END IF;
END
$proof$;
SQL

expect_failure \
  "SET ROLE service_role; DELETE FROM public.stripe_events WHERE event_id = 'evt_retained';" \
  service_delete
expect_failure \
  "DELETE FROM public.stripe_events WHERE event_id = 'evt_retained';" \
  owner_delete

retained="$(psql_cmd -Atqc \
  "SELECT count(*) FROM public.stripe_events WHERE event_id = 'evt_retained';")"
if [[ "$retained" != "1" ]]; then
  echo "Expected retained Stripe event, got $retained" >&2
  exit 1
fi

echo "preserve Stripe event idempotency PG17 proof passed"
