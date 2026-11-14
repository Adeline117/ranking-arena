#!/usr/bin/env bash

# PostgreSQL 17 disposable proof that the ingest worker's startup readiness
# trigger-catalog check accepts the trigger set installed by the launch
# replacement 20261111192134 (24 rows) and rejects the superseded original
# 20260729061000 set (21 rows). It owns an isolated temporary cluster and never
# connects to an application or remote database.
#
# The fixture recreates exactly the trigger manifest that each migration's
# postflight requires (table, trigger name, function, tgtype, deferrable,
# deferred) on stub tables and stub functions, then runs the worker's own
# trigger_rows/trigger_contract SQL, extracted verbatim from
# worker/src/ingest/attempt-bound-capture-readiness.ts.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPLACEMENT="$ROOT_DIR/supabase/migrations/20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql"
ORIGINAL="$ROOT_DIR/supabase/migrations/20260729061000_tier_a_execution_claim_enforcement.sql"
WORKER_SOURCE="$ROOT_DIR/worker/src/ingest/attempt-bound-capture-readiness.ts"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
LABEL='worker-readiness-trigger-catalog'

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
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
for file in "$REPLACEMENT" "$ORIGINAL" "$WORKER_SOURCE"; do
  [[ -f "$file" ]] || { echo "Missing input: $file" >&2; exit 1; }
done

TMP_ROOT="$(mktemp -d /tmp/worker-readiness-trigger-catalog-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((60000 + ($$ % 4000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[$LABEL] PostgreSQL log tail:" >&2
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres "$@"
}

# Render one fixture database per manifest plus the worker check query.
node - "$REPLACEMENT" "$ORIGINAL" "$WORKER_SOURCE" "$TMP_ROOT" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [replacement, original, workerSource, out] = process.argv.slice(2)

function manifest(path) {
  const sql = readFileSync(path, 'utf8')
  const start = sql.indexOf('INSERT INTO tier_a_claim_enforcement_expected_triggers')
  const end = sql.indexOf('UPDATE tier_a_claim_enforcement_expected_triggers', start)
  if (start < 0 || end < start) throw new Error(`trigger manifest not found in ${path}`)
  const pattern =
    /\(\s*'arena\.([^']+)'::pg_catalog\.regclass,\s*'([^']+)',\s*'arena\.([a-z_0-9]+)\(\)'::pg_catalog\.regprocedure,\s*(\d+),\s*(true|false),\s*(true|false)\s*\)/g
  return Array.from(sql.slice(start, end).matchAll(pattern), (m) => ({
    table: m[1],
    trigger: m[2],
    fn: m[3],
    type: Number(m[4]),
    deferrable: m[5] === 'true',
    deferred: m[6] === 'true',
  }))
}

function triggerDdl(row) {
  const t = row.type
  const events = []
  if (t & 4) events.push('INSERT')
  if (t & 8) events.push('DELETE')
  if (t & 16) events.push('UPDATE')
  if (t & 32) events.push('TRUNCATE')
  if (t & ~(1 | 2 | 4 | 8 | 16 | 32)) throw new Error(`unsupported tgtype ${t}`)
  const timing = t & 2 ? 'BEFORE' : 'AFTER'
  const level = t & 1 ? 'ROW' : 'STATEMENT'
  const constraint = row.trigger === 'tier_a_execution_fence_commit_assertion'
  if (constraint) {
    return `CREATE CONSTRAINT TRIGGER ${row.trigger} ${timing} ${events.join(' OR ')} ON arena.${row.table} ${
      row.deferrable ? 'DEFERRABLE' : 'NOT DEFERRABLE'
    } INITIALLY ${row.deferred ? 'DEFERRED' : 'IMMEDIATE'} FOR EACH ${level} EXECUTE FUNCTION arena.${row.fn}();`
  }
  return `CREATE TRIGGER ${row.trigger} ${timing} ${events.join(' OR ')} ON arena.${row.table} FOR EACH ${level} EXECUTE FUNCTION arena.${row.fn}();`
}

const workerTables = [
  'sources',
  'leaderboard_snapshots',
  'raw_objects',
  'upstream_field_inventory',
  'leaderboard_acquisition_attempts',
  'leaderboard_acquisition_outcomes',
  'tier_a_execution_claims',
  'tier_a_execution_heads',
  'tier_a_execution_write_guards',
  'tier_a_execution_window_receipts',
]

function fixture(rows) {
  const lines = ['CREATE SCHEMA arena;']
  for (const table of workerTables) lines.push(`CREATE TABLE arena.${table} (id bigint);`)
  for (const fn of new Set(rows.map((r) => r.fn))) {
    lines.push(
      `CREATE FUNCTION arena.${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;`
    )
  }
  for (const row of rows) lines.push(triggerDdl(row))
  return lines.join('\n') + '\n'
}

const replacementRows = manifest(replacement)
const originalRows = manifest(original)
writeFileSync(`${out}/replacement.sql`, fixture(replacementRows))
writeFileSync(`${out}/original.sql`, fixture(originalRows))
writeFileSync(`${out}/counts`, `${replacementRows.length} ${originalRows.length}\n`)

// Extract the worker's live trigger catalog check verbatim from its source.
const source = readFileSync(workerSource, 'utf8')
const digest = source.match(
  /TIER_A_EXECUTION_TRIGGER_CATALOG_SHA256 =\s*'([0-9a-f]{64})' as const/
)
if (!digest) throw new Error('worker trigger catalog digest not found')
const begin = source.indexOf('  target_trigger_tables(table_oid) AS (')
const finish = source.indexOf('    FROM trigger_rows\n  ),', begin)
if (begin < 0 || finish < begin) throw new Error('worker trigger catalog query not found')
const fragment = source
  .slice(begin, finish + '    FROM trigger_rows\n  )'.length)
  .replaceAll('${TIER_A_EXECUTION_TRIGGER_CATALOG_SHA256}', digest[1])
  .replaceAll('\\\\', '\\')
if (fragment.includes('${')) throw new Error('unrendered template placeholder in worker query')
writeFileSync(
  `${out}/worker-check.sql`,
  `WITH\n${fragment}\nSELECT CASE WHEN exact THEN 'exact' ELSE 'drifted' END FROM trigger_contract;\n`
)
NODE

read -r REPLACEMENT_COUNT ORIGINAL_COUNT <"$TMP_ROOT/counts"
if [[ "$REPLACEMENT_COUNT" != 24 || "$ORIGINAL_COUNT" != 21 ]]; then
  echo "[$LABEL] unexpected manifest sizes: replacement=$REPLACEMENT_COUNT original=$ORIGINAL_COUNT" >&2
  exit 1
fi

"$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust --no-instructions >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-k $SOCKET_DIR -p $PORT -c listen_addresses=''" -w start >/dev/null

psql_cmd -d postgres -c 'CREATE DATABASE launch_replacement' -c 'CREATE DATABASE superseded_original'
psql_cmd -d launch_replacement -f "$TMP_ROOT/replacement.sql"
psql_cmd -d superseded_original -f "$TMP_ROOT/original.sql"

replacement_result="$(psql_cmd -d launch_replacement -At -f "$TMP_ROOT/worker-check.sql")"
original_result="$(psql_cmd -d superseded_original -At -f "$TMP_ROOT/worker-check.sql")"

if [[ "$replacement_result" != exact ]]; then
  echo "[$LABEL] worker readiness rejects the 20261111192134 trigger catalog: $replacement_result" >&2
  exit 1
fi
if [[ "$original_result" != drifted ]]; then
  echo "[$LABEL] worker readiness still accepts the superseded 21-row catalog: $original_result" >&2
  exit 1
fi

echo "[$LABEL] worker readiness accepts the 24-row launch trigger catalog and rejects the superseded 21-row catalog"
