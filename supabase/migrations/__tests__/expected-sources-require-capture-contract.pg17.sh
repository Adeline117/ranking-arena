#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that the season expected-source set requires a
# valid attempt-bound capture contract registration (20261118113759), that the
# excluded sources are listed as unsupported instead of disappearing, and that
# the isolation rewrite (20261113011058) still applies on top.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/expected-sources-capture-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

psql_drift() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d drift "$@"
}

body_sha256() {
  psql_cmd -Atqc "
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc, 'UTF8')), 'hex')
    FROM pg_catalog.pg_proc
    WHERE oid = 'public.arena_freshness_expected_sources()'::pg_catalog.regprocedure;
  "
}

expect_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted:" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO service_role, anon, authenticated;

CREATE TABLE arena.exchanges (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  exchange_id bigint NOT NULL REFERENCES arena.exchanges(id),
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL
);

-- Production CHECKs are omitted so the negative rows can exist; the
-- predicate itself must reject them.
CREATE TABLE arena.leaderboard_capture_contracts (
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  capture_contract text NOT NULL,
  adapter_slug text NOT NULL,
  attempt_binding_contract text NOT NULL,
  requires_runner_git_sha boolean NOT NULL DEFAULT true,
  PRIMARY KEY (source_id, capture_contract)
);

CREATE TABLE arena.public_ranked_leaderboard_serving_heads (
  season_id text PRIMARY KEY,
  score_cohort_id uuid NOT NULL
);

INSERT INTO arena.exchanges (id, name) VALUES (1, 'Example');
INSERT INTO arena.sources (
  id, slug, exchange_id, adapter_slug, status, serving_mode, meta,
  timeframes_native, timeframes_derived
) VALUES
  (1,  'reg_v3',          1, 'a_v3',    'active',   'serving', '{}', '{7,30}', '{}'),
  (2,  'reg_v4',          1, 'a_v4',    'active',   'serving', '{}', '{30}',   '{}'),
  (3,  'only_v2',         1, 'a_v2',    'active',   'serving', '{}', '{7}',    '{}'),
  (4,  'legacy_unverified', 1, 'a_lu',  'active',   'serving', '{}', '{7}',    '{}'),
  (5,  'wrong_binding',   1, 'a_wb',    'active',   'serving', '{}', '{7}',    '{}'),
  (6,  'no_git_sha',      1, 'a_ng',    'active',   'serving', '{}', '{7}',    '{}'),
  (7,  'adapter_mismatch', 1, 'a_am',   'active',   'serving', '{}', '{7}',    '{}'),
  (8,  'uncontracted',    1, 'a_none',  'active',   'serving', '{}', '{7,90}', '{}'),
  (9,  'alias_reg',       1, 'a_alias', 'active',   'serving',
       '{"legacy_platform":"shared"}', '{7}', '{}'),
  (10, 'alias_unreg',     1, 'a_alias2', 'active',  'serving',
       '{"legacy_platform":"shared"}', '{7,30}', '{}'),
  (11, 'inactive_unreg',  1, 'a_inact', 'inactive', 'serving', '{}', '{7}',    '{}'),
  (12, 'bitget_bots_futures', 1, 'bitget_bots', 'active', 'serving', '{}', '{30}', '{}');

INSERT INTO arena.leaderboard_capture_contracts (
  source_id, capture_contract, adapter_slug, attempt_binding_contract,
  requires_runner_git_sha
) VALUES
  (1, 'arena.ingest.leaderboard-acquisition-manifest@3', 'a_v3',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true),
  (2, 'arena.ingest.leaderboard-acquisition-manifest@4', 'a_v4',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true),
  (3, 'arena.ingest.leaderboard-acquisition-manifest@2', 'a_v2',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true),
  (4, 'legacy_unverified', 'a_lu',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true),
  (5, 'arena.ingest.leaderboard-acquisition-manifest@3', 'a_wb',
   'arena.ingest.leaderboard-acquisition-attempt-binding@2', true),
  (6, 'arena.ingest.leaderboard-acquisition-manifest@3', 'a_ng',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', false),
  (7, 'arena.ingest.leaderboard-acquisition-manifest@3', 'other_adapter',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true),
  (9, 'arena.ingest.leaderboard-acquisition-manifest@3', 'a_alias',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true),
  -- Registered, but the Bitget-bot quarantine keeps it out of both lists.
  (12, 'arena.ingest.leaderboard-acquisition-manifest@4', 'bitget_bots',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true);
SQL

apply() {
  PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$MIGRATIONS/$1" >/dev/null
}

apply 20260718134000_freshness_expected_sources.sql
# Later authority migrations pin the function's search_path this way.
psql_cmd -qc "ALTER FUNCTION public.arena_freshness_expected_sources() SET search_path TO pg_catalog, pg_temp;"
expect_eq "legacy body digest" "$(body_sha256)" \
  "c1739275e302ac2a7429c79a0c3456680603418004cc9c3da44913de88d28b4e"

# The Bitget-bot quarantine (20261115013558) rewrites this body with exactly
# this replacement. Its prerequisite chain is out of scope here, so the
# rewrite is reproduced and proven by the quarantine's own pinned digest.
psql_cmd -q <<'SQL'
DO $quarantine$
DECLARE
  v_needle text := pg_catalog.format('%s.serving_mode = ''serving''%s', 'source_row', E'\n');
BEGIN
  EXECUTE pg_catalog.replace(
    pg_catalog.pg_get_functiondef(
      'public.arena_freshness_expected_sources()'::pg_catalog.regprocedure),
    v_needle,
    v_needle || pg_catalog.format(
$predicate$%2$s-- bitget-bot-cumulative-rank-quarantine@1
%2$sAND NOT (
%2$s  %1$s.slug = ANY (
%2$s    ARRAY[
%2$s      'bitget_bots_futures',
%2$s      'bitget_bots_spot'
%2$s    ]::pg_catalog.text[]
%2$s  )
%2$s  OR %1$s.adapter_slug = 'bitget_bots'
%2$s)
$predicate$, 'source_row', '    '));
END
$quarantine$;
SQL
expect_eq "quarantined body digest" "$(body_sha256)" \
  "c69d25e952d8f131f8873770325b3e12baf83080059c9cd8a48d9c4b094d9b86"

apply 20261113011058_leaderboard_publication_source_isolation.sql
expect_eq "isolated body digest" "$(body_sha256)" \
  "9427c4e01af650268ec07534a61101d9f177b38f07ceec621ae4e4b0a8cbc56b"

# Negative: any other body refuses the whole migration (copy of this state).
psql_cmd -qc "CREATE DATABASE drift TEMPLATE postgres;"
psql_drift -qc "
  CREATE OR REPLACE FUNCTION public.arena_freshness_expected_sources()
  RETURNS TABLE (registry_slug text, filter_source text, exchange_name text, season_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS 'SELECT NULL::text, NULL::text, NULL::text, NULL::text WHERE false
      -- leaderboard-publication-source-isolation@1';
"
if DRIFT="$(psql_drift -q -f "$MIGRATIONS/20261118113759_expected_sources_require_capture_contract.sql" 2>&1)"; then
  echo "a drifted freshness body was not refused" >&2
  exit 1
fi
if [[ "$DRIFT" != *"body drifted from the reviewed post-isolation body"* ]]; then
  echo "drift refusal had the wrong reason: $DRIFT" >&2
  exit 1
fi
if [[ "$(psql_drift -Atqc "SELECT pg_catalog.to_regclass('arena.leaderboard_publication_unsupported_sources') IS NULL")" != "t" ]]; then
  echo "a refused migration left objects behind" >&2
  exit 1
fi

expected_sets() {
  psql_cmd -Atqc "
    SELECT COALESCE(pg_catalog.string_agg(entry, ',' ORDER BY entry), '')
    FROM (
      SELECT DISTINCT expected.season_id || ':' || expected.filter_source AS entry
      FROM public.arena_freshness_expected_sources() AS expected
    ) AS listed;
  "
}

BEFORE="$(expected_sets)"
expect_eq "pre-migration expected set" "$BEFORE" \
  "30D:reg_v3,30D:reg_v4,30D:shared,7D:adapter_mismatch,7D:legacy_unverified,7D:no_git_sha,7D:only_v2,7D:reg_v3,7D:shared,7D:uncontracted,7D:wrong_binding,90D:uncontracted"

apply 20261118113759_expected_sources_require_capture_contract.sql
expect_eq "final body digest" "$(body_sha256)" \
  "2d7d679a100ed09b60c40a53e57d7bd2907d624a6738c7c49ce81496b0e9ebd2"
# Replay converges to the same body.
apply 20261118113759_expected_sources_require_capture_contract.sql
expect_eq "replayed body digest" "$(body_sha256)" \
  "2d7d679a100ed09b60c40a53e57d7bd2907d624a6738c7c49ce81496b0e9ebd2"

MARKERS="$(
  psql_cmd -Atqc "
    SELECT
      (pg_catalog.length(prosrc) - pg_catalog.length(pg_catalog.replace(
        prosrc, 'leaderboard-capture-contract-registration@1', '')))
        / pg_catalog.length('leaderboard-capture-contract-registration@1')
      || '|' || (pg_catalog.strpos(prosrc, 'leaderboard-publication-source-isolation@1') > 0)
    FROM pg_catalog.pg_proc
    WHERE oid = 'public.arena_freshness_expected_sources()'::pg_catalog.regprocedure;
  "
)"
expect_eq "rewrite markers" "$MARKERS" "1|true"

# Positive: @3 and @4 registrations stay; an alias stays in a season when one
# of its registry rows declaring that season is registered (7D:shared), and
# leaves a season only its unregistered row declares (30D:shared). Negative: @2, legacy_unverified, wrong binding,
# requires_runner_git_sha=false, adapter mismatch, and no row at all leave.
AFTER="$(expected_sets)"
expect_eq "expected set" "$AFTER" "30D:reg_v3,30D:reg_v4,7D:reg_v3,7D:shared"

unsupported_sets() {
  psql_cmd -Atqc "
    SELECT COALESCE(pg_catalog.string_agg(entry, ',' ORDER BY entry), '')
    FROM (
      SELECT DISTINCT unsupported.season_id || ':' || unsupported.filter_source AS entry
      FROM public.arena_publication_unsupported_sources() AS unsupported
    ) AS listed;
  "
}

UNSUPPORTED="$(unsupported_sets)"
expect_eq "unsupported set" "$UNSUPPORTED" \
  "30D:shared,7D:adapter_mismatch,7D:legacy_unverified,7D:no_git_sha,7D:only_v2,7D:uncontracted,7D:wrong_binding,90D:uncontracted"

# Expected + unsupported is exactly the pre-migration set: nothing vanished.
UNION="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(entry, ',' ORDER BY entry)
    FROM (
      SELECT season_id || ':' || filter_source AS entry
        FROM public.arena_freshness_expected_sources()
      UNION
      SELECT season_id || ':' || filter_source
        FROM public.arena_publication_unsupported_sources()
    ) AS listed;
  "
)"
expect_eq "expected ∪ unsupported" "$UNION" "$BEFORE"

# The unsupported reader's local setting must not leak into the session.
LEAK="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.count(*) FROM public.arena_publication_unsupported_sources();
    SELECT pg_catalog.count(DISTINCT season_id || filter_source)
      FROM public.arena_freshness_expected_sources();
  " | tail -1
)"
expect_eq "setting leak" "$LEAK" "4"

# Registering a contract moves the source into the expected set; removing one
# moves it back out. Derived from DB state only.
psql_cmd -qc "
  INSERT INTO arena.leaderboard_capture_contracts VALUES
    (8, 'arena.ingest.leaderboard-acquisition-manifest@3', 'a_none',
     'arena.ingest.leaderboard-acquisition-attempt-binding@1', true);
  DELETE FROM arena.leaderboard_capture_contracts WHERE source_id = 2;
"
expect_eq "expected after registry change" "$(expected_sets)" \
  "30D:reg_v3,7D:reg_v3,7D:shared,7D:uncontracted,90D:uncontracted"
expect_eq "unsupported after registry change" "$(unsupported_sets)" \
  "30D:reg_v4,30D:shared,7D:adapter_mismatch,7D:legacy_unverified,7D:no_git_sha,7D:only_v2,7D:wrong_binding"

# An emptied registry empties the expected set (the orchestrator's floor then
# refuses publication) and lists every declared source as unsupported.
EMPTIED="$(
  psql_cmd -Atq <<'SQL'
BEGIN;
DELETE FROM arena.leaderboard_capture_contracts;
SELECT pg_catalog.count(*) FROM public.arena_freshness_expected_sources();
SELECT pg_catalog.count(DISTINCT season_id || filter_source)
  FROM public.arena_publication_unsupported_sources();
ROLLBACK;
SQL
)"
expect_eq "emptied registry" "$(echo "$EMPTIED" | tr '\n' '|')" "0|12|"

# Isolation still applies on top of the reduced set, and an isolated source is
# not reported as unsupported.
psql_cmd -qc "
  INSERT INTO arena.leaderboard_publication_source_isolations (
    season_id, filter_source, reasons, first_isolated_at, score_cohort_id
  ) VALUES ('7D', 'reg_v3', ARRAY['missing'], pg_catalog.now(),
            '00000000-0000-4000-8000-000000000001');
"
expect_eq "expected with isolation" "$(expected_sets)" \
  "30D:reg_v3,7D:shared,7D:uncontracted,90D:uncontracted"
expect_eq "unsupported with isolation" "$(unsupported_sets)" \
  "30D:reg_v4,30D:shared,7D:adapter_mismatch,7D:legacy_unverified,7D:no_git_sha,7D:only_v2,7D:wrong_binding"

# Per-publication record: append-only, and the public reader returns only the
# current serving head's list.
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_publication_unsupported_sources (
  season_id, score_cohort_id, filter_sources
) VALUES
  ('7D', '00000000-0000-4000-8000-00000000000a', ARRAY['old_source']),
  ('7D', '00000000-0000-4000-8000-00000000000b', ARRAY['only_v2', 'uncontracted']),
  ('30D', '00000000-0000-4000-8000-00000000000c', ARRAY[]::text[]);
INSERT INTO arena.public_ranked_leaderboard_serving_heads VALUES
  ('7D', '00000000-0000-4000-8000-00000000000b'),
  ('30D', '00000000-0000-4000-8000-00000000000c');
SQL

PUBLIC_LIST="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT pg_catalog.string_agg(season_id || ':' || filter_source, ',')
    FROM public.public_leaderboard_unsupported_sources();
  "
)"
expect_eq "public unsupported list" "$PUBLIC_LIST" "7D:only_v2,7D:uncontracted"

if psql_cmd -qc "
  UPDATE arena.leaderboard_publication_unsupported_sources
     SET filter_sources = ARRAY[]::text[];
" >/dev/null 2>&1; then
  echo "unsupported-source records accepted an UPDATE" >&2
  exit 1
fi
if psql_cmd -qc "
  DELETE FROM arena.leaderboard_publication_unsupported_sources;
" >/dev/null 2>&1; then
  echo "unsupported-source records accepted a DELETE" >&2
  exit 1
fi

PRIVILEGES="$(
  psql_cmd -Atqc "
    SELECT
      has_function_privilege('service_role',
        'public.arena_freshness_expected_sources()', 'EXECUTE') || '|' ||
      has_function_privilege('anon',
        'public.arena_freshness_expected_sources()', 'EXECUTE') || '|' ||
      has_function_privilege('service_role',
        'public.arena_publication_unsupported_sources()', 'EXECUTE') || '|' ||
      has_function_privilege('anon',
        'public.arena_publication_unsupported_sources()', 'EXECUTE') || '|' ||
      has_function_privilege('anon',
        'arena.leaderboard_capture_contract_registered(integer,text)', 'EXECUTE') || '|' ||
      has_function_privilege('anon',
        'public.public_leaderboard_unsupported_sources()', 'EXECUTE') || '|' ||
      has_table_privilege('service_role',
        'arena.leaderboard_publication_unsupported_sources', 'INSERT') || '|' ||
      has_table_privilege('anon',
        'arena.leaderboard_publication_unsupported_sources', 'SELECT');
  "
)"
expect_eq "privileges" "$PRIVILEGES" "true|false|true|false|false|true|true|false"

echo "expected sources require capture contract PostgreSQL 17 proof passed"
