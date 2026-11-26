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
#
# It also proves the exclusion of the arena.sources name-uniqueness trigger
# (20261122204058) is by exact identity: the trigger exactly as that migration
# installs it leaves the catalog exact, while the same trigger name with a
# replaced function body, a different UPDATE OF column list, or a WHEN
# condition makes it drift. arena.sources carries columns at the production
# attnums (2 slug, 25 serving_mode, 26 status, 27 meta) so tgattr matches.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPLACEMENT="$ROOT_DIR/supabase/migrations/20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql"
NAME_GUARD="$ROOT_DIR/supabase/migrations/20261122204058_resolve_trader_public_source.sql"
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
for file in "$REPLACEMENT" "$ORIGINAL" "$WORKER_SOURCE" "$NAME_GUARD"; do
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
node - "$REPLACEMENT" "$ORIGINAL" "$WORKER_SOURCE" "$TMP_ROOT" "$NAME_GUARD" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [replacement, original, workerSource, out, nameGuard] = process.argv.slice(2)

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
  for (const table of workerTables) {
    if (table !== 'sources') {
      lines.push(`CREATE TABLE arena.${table} (id bigint);`)
      continue
    }
    // Production attnums of the columns the name guard's UPDATE OF lists:
    // 2 slug, 25 serving_mode, 26 status, 27 meta (fetch_region at 28).
    const columns = ['id bigint', 'slug text']
    for (let n = 3; n <= 24; n += 1) columns.push(`filler_${n} text`)
    columns.push('serving_mode text', 'status text', 'meta jsonb', 'fetch_region text')
    lines.push(`CREATE TABLE arena.sources (${columns.join(', ')});`)
  }
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

// The name guard exactly as 20261122204058 installs it (function + trigger).
const guardSql = readFileSync(nameGuard, 'utf8')
const fnStart = guardSql.indexOf('CREATE FUNCTION arena.reject_ambiguous_serving_source_name()')
const fnEnd = guardSql.indexOf('$function$;', guardSql.indexOf('$function$', fnStart) + 10)
const trStart = guardSql.indexOf('CREATE TRIGGER sources_reject_ambiguous_serving_name')
const trEnd = guardSql.indexOf(';', trStart)
if (fnStart < 0 || fnEnd < fnStart || trStart < 0 || trEnd < trStart) {
  throw new Error('name guard function or trigger not found in 20261122204058')
}
const guardFunction = guardSql.slice(fnStart, fnEnd + '$function$;'.length)
const guardTrigger = guardSql.slice(trStart, trEnd + 1)
writeFileSync(`${out}/name-guard.sql`, `${guardFunction}\n${guardTrigger}\n`)
writeFileSync(
  `${out}/name-guard-trigger.sql`,
  `DROP TRIGGER IF EXISTS sources_reject_ambiguous_serving_name ON arena.sources;\n${guardTrigger}\n`
)

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

# The arena.sources name-uniqueness guard. Each case runs in its own
# transaction on the launch catalog and is rolled back.
check_with() {
  local output
  if output="$(psql_cmd -d launch_replacement -At -c 'BEGIN' -f "$TMP_ROOT/name-guard.sql" -c "$1" \
    -f "$TMP_ROOT/worker-check.sql" -c 'ROLLBACK' 2>/dev/null)"; then
    grep -E '^(exact|drifted)$' <<<"$output"
  else
    # The worker runs this query inside its startup gate; an error there
    # propagates and fails the gate closed.
    echo error
  fi
}
expect_check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "[$LABEL] $label: expected $expected, got ${actual:-<nothing>}" >&2
    exit 1
  fi
  echo "[$LABEL] ok: $label -> $expected"
}

expect_check "the name guard exactly as 20261122204058 installs it is excluded" exact \
  "$(check_with 'SELECT 1')"
expect_check "the same trigger with a replaced function body counts" drifted \
  "$(check_with "CREATE OR REPLACE FUNCTION arena.reject_ambiguous_serving_source_name()
     RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
     AS \$f\$ BEGIN NEW.fetch_region := 'elsewhere'; RETURN NEW; END \$f\$")"
expect_check "the same trigger on UPDATE OF fetch_region counts" drifted \
  "$(check_with "DROP TRIGGER sources_reject_ambiguous_serving_name ON arena.sources;
     CREATE TRIGGER sources_reject_ambiguous_serving_name
       BEFORE INSERT OR UPDATE OF fetch_region ON arena.sources
       FOR EACH ROW EXECUTE FUNCTION arena.reject_ambiguous_serving_source_name()")"
# A WHEN condition on a pinned table makes the catalog query itself fail:
# pg_get_expr cannot deparse a trigger qual (it references NEW/OLD). The
# worker's gate does not catch it, so startup still fails closed.
expect_check "the same trigger with a WHEN condition fails the gate (query error)" error \
  "$(check_with "DROP TRIGGER sources_reject_ambiguous_serving_name ON arena.sources;
     CREATE TRIGGER sources_reject_ambiguous_serving_name
       BEFORE INSERT OR UPDATE OF slug, meta, status, serving_mode ON arena.sources
       FOR EACH ROW WHEN (NEW.status = 'active')
       EXECUTE FUNCTION arena.reject_ambiguous_serving_source_name()")"
expect_check "the same trigger made SECURITY DEFINER counts" drifted \
  "$(check_with 'ALTER FUNCTION arena.reject_ambiguous_serving_source_name() SECURITY DEFINER')"
expect_check "the same trigger disabled counts" drifted \
  "$(check_with 'ALTER TABLE arena.sources DISABLE TRIGGER sources_reject_ambiguous_serving_name')"
expect_check "re-creating it exactly is still excluded" exact \
  "$(check_with "$(cat "$TMP_ROOT/name-guard-trigger.sql")")"

echo "[$LABEL] the arena.sources name guard is excluded only by its exact identity"
