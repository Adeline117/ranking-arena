#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260722054000_metric_trust_source_page_lineage.sql"
AUTHORITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260722050000_metric_trust_attempt_outcome_authority.sql"
MANIFEST_MIGRATION="$ROOT_DIR/supabase/migrations/20260722051000_leaderboard_score_input_manifest_contract.sql"
PNL_MIGRATION="$ROOT_DIR/supabase/migrations/20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql"
BINANCE_MIGRATION="$ROOT_DIR/supabase/migrations/20260722053000_binance_spot_metric_source_contract.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/metric-trust-lineage-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 4000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
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
  local label="$1"
  local sql="$2"
  local expected="${3:-}"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ -n "$expected" ]] && [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    "${PAGER:-cat}" "$ERROR_FILE" >&2 || true
    exit 1
  fi
}

insert_exact_ledger() {
  local version="$1"
  local name="$2"
  local file="$3"
  local hash="$4"
  local body
  # The sentinel preserves the file's trailing newline through command
  # substitution so the ledger digest is byte-identical to sha256sum.
  body="$(
    dd if="$file" status=none
    printf '%s' '__ARENA_LEDGER_SENTINEL__'
  )"
  body="${body%__ARENA_LEDGER_SENTINEL__}"
  psql_cmd -q \
    -v version="$version" \
    -v name="$name" \
    -v body="$body" \
    -v hash="$hash" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (
  version, statements, name, created_by, idempotency_key
) VALUES (
  :'version',
  ARRAY[:'body'],
  :'name',
  'supabase-mcp',
  'mcp-generated:' || :'version'
);
SQL
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

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE leaked_default_role NOLOGIN;
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE SCHEMA arena;
CREATE SCHEMA extensions;
CREATE SCHEMA supabase_migrations;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[] NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  idempotency_key text NOT NULL
);

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe integer NOT NULL,
  source_run_id text,
  trust_artifact_role text,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX uidx_raw_population_manifest_per_run
  ON arena.raw_objects (id) WHERE false;
CREATE UNIQUE INDEX uidx_raw_tier_a_population_per_run
  ON arena.raw_objects (id) WHERE false;

CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe integer NOT NULL,
  snapshot_id bigint NOT NULL,
  population_raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id)
);

CREATE TABLE arena.metric_trust_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_run_id text NOT NULL REFERENCES arena.metric_trust_runs(source_run_id),
  source_id smallint NOT NULL,
  timeframe integer NOT NULL,
  snapshot_id bigint NOT NULL,
  quality text NOT NULL,
  freshness_state text NOT NULL,
  blocking_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Mirror the ordering-sensitive part of the existing shadow-gate validator:
-- the lineage trigger must downgrade the old writer before this trigger sees
-- a complete record with incomplete trust evidence.
CREATE FUNCTION arena.validate_metric_trust_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.quality = 'complete' AND (
    NEW.freshness_state <> 'verified'
    OR NEW.blocking_reasons <> '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'complete metric observation requires a complete verified run';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER validate_metric_trust_observation_before_insert
BEFORE INSERT ON arena.metric_trust_observations
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_observation();

CREATE VIEW arena.metric_rankable_observations
WITH (security_invoker = true)
AS SELECT * FROM arena.metric_trust_observations;

CREATE TABLE arena.raw_object_gc_queue (id bigint PRIMARY KEY);
CREATE TABLE arena.leaderboard_acquisition_attempts (id bigint PRIMARY KEY);
CREATE TABLE arena.leaderboard_acquisition_outcomes (id bigint PRIMARY KEY);
CREATE VIEW arena.latest_terminal_leaderboard_acquisitions
AS SELECT * FROM arena.leaderboard_acquisition_outcomes;

CREATE TABLE arena.leaderboard_score_input_manifests (
  id uuid PRIMARY KEY,
  manifest jsonb NOT NULL,
  CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl
    CHECK (pg_catalog.jsonb_typeof(manifest) = 'object')
);

CREATE FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER metric_trust_runs_attempt_outcome_authority_before_insert
BEFORE INSERT ON arena.metric_trust_runs
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_attempt_outcome_authority();

CREATE FUNCTION arena.serialize_leaderboard_terminal_publication()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
)
RETURNS jsonb LANGUAGE sql STABLE AS $function$
  SELECT '{}'::jsonb
$function$;

CREATE FUNCTION arena.seal_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb,
  timestamp with time zone
)
RETURNS jsonb LANGUAGE sql VOLATILE AS $function$
  SELECT '{}'::jsonb
$function$;

CREATE FUNCTION arena.verify_leaderboard_score_input_manifest_v1(uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $function$
  SELECT '{}'::jsonb
$function$;

INSERT INTO arena.raw_objects (
  id, source_id, timeframe, source_run_id, trust_artifact_role,
  quarantined, meta
) VALUES (
  1, 1, 30, repeat('a', 64), 'source_payload', false,
  '{
    "pageCount":3,
    "parserPageCount":2,
    "parserSourcePageOrdinals":[1,3]
  }'::jsonb
);

INSERT INTO arena.metric_trust_runs (
  source_run_id, source_id, timeframe, snapshot_id, population_raw_object_id
) VALUES (repeat('a', 64), 1, 30, 100, 1);

-- This append-only legacy row cannot be assigned a page honestly. The new
-- migration must preserve it while keeping release readiness false.
INSERT INTO arena.metric_trust_observations (
  source_run_id, source_id, timeframe, snapshot_id, quality, freshness_state
) VALUES (repeat('a', 64), 1, 30, 100, 'complete', 'verified');

ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO leaked_default_role;
SQL

insert_exact_ledger \
  '20990101000001' \
  'metric_trust_attempt_outcome_authority' \
  "$AUTHORITY_MIGRATION" \
  '3648ac33324eb99e476eb15dc624b37d6d086ac6eef92c9b34dc8e30399dd92f'
insert_exact_ledger \
  '20990101000002' \
  'leaderboard_score_input_manifest_contract' \
  "$MANIFEST_MIGRATION" \
  'fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'
insert_exact_ledger \
  '20990101000003' \
  'leaderboard_score_input_manifest_rank_eligible_pnl' \
  "$PNL_MIGRATION" \
  '34d1af48d66a4b3cedcee548e3438ba81fa9cc3fdca7a00f308d7f768f30150e'
insert_exact_ledger \
  '20990101000004' \
  'binance_spot_metric_source_contract' \
  "$BINANCE_MIGRATION" \
  '1f4ce27a0a44cfc6f9c1d11c113dc2db7aa5eed170ef3b38b1469c0a1c758abc'

if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
  echo 'source-page lineage migration accepted an immutable legacy verified row' >&2
  exit 1
fi
if [[ "$(<"$ERROR_FILE")" != *'legacy verified observations require a reviewed forward quarantine'* ]]; then
  echo 'legacy source-page lineage failed for the wrong reason' >&2
  "${PAGER:-cat}" "$ERROR_FILE" >&2 || true
  exit 1
fi

# Reset only the disposable preflight fixture after proving production would
# stop. The real table is append-only and requires a separate forward
# quarantine; this DELETE is never presented as an operational recovery path.
psql_cmd -q -c 'DELETE FROM arena.metric_trust_observations;'
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.reject_direct_metric_trust_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'metric trust records are append-only; insert a new run instead';
END
$function$;

CREATE TRIGGER metric_trust_observations_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_trust_observations
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
SQL

psql_cmd -q -f "$MIGRATION"

LINEAGE_HASH="$(sha256sum "$MIGRATION" | awk '{print $1}')"
insert_exact_ledger \
  '20990101000005' \
  'metric_trust_source_page_lineage' \
  "$MIGRATION" \
  "$LINEAGE_HASH"

READY="$(
  psql_cmd -Atqc "
    SELECT
      (result->>'ready') || '|' ||
      (result->>'legacy_complete_verified_count') || '|' ||
      pg_catalog.jsonb_array_length(result->'missing') || '|' ||
      (result->>'release_migration_sha256')
    FROM (
      SELECT public.arena_metric_trust_release_readiness() AS result
    ) AS readiness;
  "
)"
if [[ "$READY" != "true|0|0|$LINEAGE_HASH" ]]; then
  echo "complete source-page lineage contract was not release ready: $READY" >&2
  psql_cmd -Atqc 'SELECT public.arena_metric_trust_release_readiness();' >&2
  exit 1
fi

psql_cmd -q <<'SQL'
INSERT INTO arena.metric_trust_observations (
  source_run_id, source_id, timeframe, snapshot_id, quality,
  freshness_state, source_page_ordinal
) VALUES
  (repeat('a', 64), 1, 30, 100, 'unknown', 'verified', 3),
  (repeat('a', 64), 1, 30, 100, 'unknown', 'unknown', NULL);
SQL

psql_cmd -q -c "
  INSERT INTO arena.metric_trust_observations
    (source_run_id, source_id, timeframe, snapshot_id, quality, freshness_state,
     blocking_reasons, source_page_ordinal)
  VALUES (
    repeat('a', 64), 1, 30, 100, 'complete', 'verified',
    '[{\"code\":\"native_window_boundary_unverified\",\"state\":\"unknown\"}]'::jsonb,
    NULL
  );
"
DOWNGRADED="$(
  psql_cmd -Atqc "
    SELECT
      quality || '|' || freshness_state || '|' ||
      (blocking_reasons @> '[{\"code\":\"source_page_lineage_missing\",\"state\":\"unknown\"}]'::jsonb)::text || '|' ||
      (blocking_reasons @> '[{\"code\":\"native_window_boundary_unverified\",\"state\":\"unknown\"}]'::jsonb)::text || '|' ||
      pg_catalog.jsonb_array_length(blocking_reasons)::text
    FROM arena.metric_trust_observations
    ORDER BY id DESC
    LIMIT 1;
  "
)"
if [[ "$DOWNGRADED" != 'unknown|unknown|true|true|2' ]]; then
  echo "pre-lineage writer was not safely downgraded: $DOWNGRADED" >&2
  exit 1
fi

expect_failure \
  'unknown observation with asserted ordinal' \
  "INSERT INTO arena.metric_trust_observations
     (source_run_id, source_id, timeframe, snapshot_id, quality, freshness_state,
      source_page_ordinal)
   VALUES (repeat('a', 64), 1, 30, 100, 'unknown', 'unknown', 1);" \
  'source-page ordinal requires verified freshness'

expect_failure \
  'zero source-page ordinal' \
  "INSERT INTO arena.metric_trust_observations
     (source_run_id, source_id, timeframe, snapshot_id, quality, freshness_state,
      source_page_ordinal)
   VALUES (repeat('a', 64), 1, 30, 100, 'unknown', 'verified', 0);" \
  'positive ordinal'

expect_failure \
  'negative source-page ordinal' \
  "INSERT INTO arena.metric_trust_observations
     (source_run_id, source_id, timeframe, snapshot_id, quality, freshness_state,
      source_page_ordinal)
   VALUES (repeat('a', 64), 1, 30, 100, 'unknown', 'verified', -1);" \
  'positive ordinal'

expect_failure \
  'source-page ordinal absent from immutable parser lineage' \
  "INSERT INTO arena.metric_trust_observations
     (source_run_id, source_id, timeframe, snapshot_id, quality, freshness_state,
      source_page_ordinal)
   VALUES (repeat('a', 64), 1, 30, 100, 'unknown', 'verified', 2);" \
  'not present in immutable parser source-page lineage'

expect_failure \
  'append-only observation deletion' \
  "DELETE FROM arena.metric_trust_observations;" \
  'metric trust records are append-only'

expect_failure \
  'source-page ordinal beyond immutable pageCount' \
  "INSERT INTO arena.metric_trust_observations
     (source_run_id, source_id, timeframe, snapshot_id, quality, freshness_state,
      source_page_ordinal)
   VALUES (repeat('a', 64), 1, 30, 100, 'unknown', 'verified', 4);" \
  'not present in immutable parser source-page lineage'

ACL="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_function_privilege(
        'service_role',
        'public.arena_metric_trust_release_readiness()',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'anon',
        'public.arena_metric_trust_release_readiness()',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'authenticated',
        'public.arena_metric_trust_release_readiness()',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'leaked_default_role',
        'public.arena_metric_trust_release_readiness()',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'service_role',
        'arena.validate_metric_trust_source_page_lineage()',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'leaked_default_role',
        'arena.validate_metric_trust_source_page_lineage()',
        'EXECUTE'
      );
  "
)"
if [[ "$ACL" != "true|false|false|false|false|false" ]]; then
  echo "source-page lineage function ACL drifted: $ACL" >&2
  exit 1
fi

SERVICE_RESULT="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.arena_metric_trust_release_readiness()->>'contract';
    RESET ROLE;
  "
)"
if [[ "$SERVICE_RESULT" != 'arena.metric-trust-release-readiness@1' ]]; then
  echo "service role could not execute release readiness: $SERVICE_RESULT" >&2
  exit 1
fi

expect_failure \
  'anonymous release-readiness execution' \
  "SET ROLE anon; SELECT public.arena_metric_trust_release_readiness();" \
  'permission denied for function arena_metric_trust_release_readiness'

echo 'metric-trust source-page lineage PostgreSQL 17 proof passed'
