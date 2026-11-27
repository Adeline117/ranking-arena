#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261127103322: the columnar score bundle carries
# exactly the object-form bundle.
#
# The wrapped public.arena_score_inputs_publish_bundle_json is a stub that
# returns 11,682 score rows in the 21-key shape arena.publication_score_rows_json
# builds (nulls, empty and non-empty metric arrays, non-ASCII handles,
# negative and fractional numbers) and 26 physical boards: the size of the
# 2026-11-27 production 90D bundle.
#   = decoding the columnar rows in SQL gives the object-form rows, same order
#   = the real TypeScript decoder (lib/rankings/publication/columnar-score-bundle.ts)
#     gives a deep-equal bundle
#   + the columnar bundle is at most 70% of the object-form bytes
#   - a row with an extra key, a missing key, or a non-object row raises
#   - anon / authenticated cannot execute it; service_role can
# The migration is applied by a non-superuser owner. Isolated cluster on a
# private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NEW_MIGRATION="$ROOT_DIR/supabase/migrations/20261127103322_score_bundle_columnar_rows.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/score-bundle-columnar-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((53000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -40 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_as() {
  local role="$1"
  shift
  PGOPTIONS="-c client_min_messages=warning" \
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U bootstrap --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_as bootstrap -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon LOGIN NOSUPERUSER;
CREATE ROLE authenticated LOGIN NOSUPERUSER;
CREATE ROLE service_role LOGIN NOSUPERUSER;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL

# The stub: 'normal' rows, or one bad row (extra key / missing key / not an object).
psql_as postgres -q <<'SQL'
CREATE TABLE public.stub_mode (mode text NOT NULL);
INSERT INTO public.stub_mode VALUES ('normal');

CREATE FUNCTION public.arena_score_inputs_publish_bundle_json(
  p_window text, p_per_platform_limit integer DEFAULT 1000, p_max_age_hours integer DEFAULT 48
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH score_rows AS (
    SELECT n, jsonb_build_object(
      'platform', 'source_' || (n % 26),
      'market_type', CASE WHEN n % 7 = 0 THEN 'spot' ELSE 'futures' END,
      'trader_key', 'trader-' || n,
      'board_rank', CASE WHEN n % 97 = 0 THEN NULL ELSE 1 + n % 1000 END,
      'roi_pct', round(((n * 37) % 20001 - 10000) / 7.0, 6),
      'pnl_usd', CASE WHEN n % 5 = 0 THEN NULL ELSE round(((n * 7919) % 1000003) / 3.0, 4) END,
      'win_rate', CASE WHEN n % 3 = 0 THEN NULL ELSE (n % 101)::numeric END,
      'max_drawdown', CASE WHEN n % 4 = 0 THEN NULL ELSE round((n % 1000) / 10.0, 2) END,
      'copiers', CASE WHEN n % 6 = 0 THEN NULL ELSE n % 5000 END,
      'trades_count', CASE WHEN n % 8 = 0 THEN NULL ELSE n % 20000 END,
      'sharpe_ratio', CASE WHEN n % 2 = 0 THEN NULL ELSE round((n % 400 - 200) / 100.0, 4) END,
      'sortino_ratio', NULL,
      'calmar_ratio', CASE WHEN n % 9 = 0 THEN round((n % 300) / 100.0, 3) END,
      'volatility_pct', NULL,
      'unevidenced_metrics', CASE WHEN n % 2 = 0 THEN '["mdd", "win_rate"]'::jsonb ELSE '[]'::jsonb END,
      'trader_kind', CASE WHEN n % 50 = 0 THEN 'bot' END,
      'handle', CASE WHEN n % 11 = 0 THEN NULL WHEN n % 13 = 0 THEN '交易员 ' || n || ' "✓"' ELSE 'Trader ' || n END,
      'avatar_url', CASE WHEN n % 3 = 0 THEN NULL ELSE 'https://cdn.example.invalid/avatars/' || md5(n::text) || '.png' END,
      'currency', 'USDT',
      'as_of', '2026-11-27T12:' || lpad((n % 60)::text, 2, '0') || ':00.000000+00:00',
      'board_as_of', '2026-11-27T12:00:00.000000+00:00'
    ) AS row_value
    FROM generate_series(1, 11682) AS n
  )
  SELECT jsonb_build_object(
    'scoreRows', (
      SELECT jsonb_agg(
               CASE
                 WHEN n = 4321 AND mode = 'extra_key' THEN row_value || '{"extra": 1}'
                 WHEN n = 4321 AND mode = 'missing_key' THEN row_value - 'roi_pct'
                 WHEN n = 4321 AND mode = 'not_object' THEN '[1, 2]'::jsonb
                 ELSE row_value
               END
               ORDER BY n)
        FROM score_rows CROSS JOIN public.stub_mode),
    'physicalBoards', (
      SELECT jsonb_agg(jsonb_build_object('registry_slug', 'source_' || b, 'snapshot_id', 1000 + b,
                                          'evidence_status', 'passed') ORDER BY b)
        FROM generate_series(0, 25) AS b)
  )
$$;
SQL

psql_as postgres -q -f "$NEW_MIGRATION" >/dev/null

# Object form and columnar form, as the publisher would receive them.
psql_as postgres -Atqc "SELECT public.arena_score_inputs_publish_bundle_json('90D', 1000, 48)" \
  >"$TMP_ROOT/object.json"
psql_as postgres -Atqc "SELECT public.arena_score_inputs_publish_bundle_columnar_json('90D', 1000, 48)" \
  >"$TMP_ROOT/columnar.json"

assert_equal "decoding the columnar rows in SQL gives the object-form bundle" "t" \
  "$(psql_as postgres -Atqc "
     WITH b AS (SELECT public.arena_score_inputs_publish_bundle_json('90D', 1000, 48) AS o,
                       public.arena_score_inputs_publish_bundle_columnar_json('90D', 1000, 48) AS c)
     SELECT (SELECT jsonb_agg(
                      (SELECT jsonb_object_agg(col.name, v.value->((col.pos - 1)::int))
                         FROM jsonb_array_elements_text(c->'scoreRowColumns') WITH ORDINALITY AS col(name, pos))
                      ORDER BY v.pos)
               FROM jsonb_array_elements(c->'scoreRowValues') WITH ORDINALITY AS v(value, pos))
            = o->'scoreRows'
        AND c->'physicalBoards' = o->'physicalBoards'
        AND jsonb_array_length(c->'scoreRowValues') = 11682
        AND jsonb_array_length(c->'scoreRowColumns') = 21
       FROM b")"

(cd "$ROOT_DIR" && npx tsx --eval "
  import { readFileSync } from 'node:fs'
  import { isDeepStrictEqual } from 'node:util'
  import { decodeColumnarScoreBundle } from './lib/rankings/publication/columnar-score-bundle.ts'
  const objectForm = JSON.parse(readFileSync('$TMP_ROOT/object.json', 'utf8'))
  const decoded = decodeColumnarScoreBundle(JSON.parse(readFileSync('$TMP_ROOT/columnar.json', 'utf8')))
  // Key order is not compared: jsonb stores object keys in its own order, and
  // the strict parse and the score-input digest read values by name.
  const same = isDeepStrictEqual(decoded, objectForm)
  process.stdout.write(same ? 'same\n' : 'different\n')
") >"$TMP_ROOT/decoded.txt"
assert_equal "the TypeScript decoder rebuilds a deep-equal bundle" "same" "$(cat "$TMP_ROOT/decoded.txt")"

OBJECT_BYTES="$(wc -c <"$TMP_ROOT/object.json" | tr -d ' ')"
COLUMNAR_BYTES="$(wc -c <"$TMP_ROOT/columnar.json" | tr -d ' ')"
echo "bytes: object form $OBJECT_BYTES, columnar $COLUMNAR_BYTES"
assert_equal "the columnar bundle is at most 70% of the object form" "yes" \
  "$( ((COLUMNAR_BYTES * 10 <= OBJECT_BYTES * 7)) && echo yes || echo no)"

for mode in extra_key missing_key not_object; do
  psql_as postgres -q -c "UPDATE public.stub_mode SET mode = '$mode'"
  if psql_as postgres -Atqc \
      "SELECT public.arena_score_inputs_publish_bundle_columnar_json('90D', 1000, 48) IS NOT NULL" \
      >/dev/null 2>"$TMP_ROOT/$mode.err"; then
    echo "a row with $mode was reshaped instead of refused" >&2
    exit 1
  fi
  grep -q '1 score row(s) do not have exactly the 21 columnar keys' "$TMP_ROOT/$mode.err"
  echo "ok: a row with $mode raises"
done
psql_as postgres -q -c "UPDATE public.stub_mode SET mode = 'normal'"

# The stub itself is not a grant fixture; only the new function's grants are checked.
assert_equal "anon / authenticated cannot execute it; service_role can" "f:f:t" \
  "$(psql_as postgres -Atqc "
     SELECT has_function_privilege('anon', 'public.arena_score_inputs_publish_bundle_columnar_json(text,int,int)', 'EXECUTE')
            || ':' || has_function_privilege('authenticated', 'public.arena_score_inputs_publish_bundle_columnar_json(text,int,int)', 'EXECUTE')
            || ':' || has_function_privilege('service_role', 'public.arena_score_inputs_publish_bundle_columnar_json(text,int,int)', 'EXECUTE')" \
     | sed 's/true/t/g; s/false/f/g')"

echo "score bundle columnar rows PostgreSQL 17 proof passed"
