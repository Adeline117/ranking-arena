import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '../..')
const SOURCE_ROOTS = [
  'app',
  'cloudflare-worker',
  'connectors',
  'infra',
  'k6',
  'lib',
  'script',
  'scripts',
  'supabase/functions',
  'worker',
  'workers',
]
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  '.next',
  '.turbo',
  '__fixtures__',
  '__integration__',
  '__tests__',
  'build',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
  'test-results',
  'tests',
])

const qualifiedArenaBots = String.raw`(?:"arena"|arena)\s*\.\s*(?:"bots"|bots)(?![A-Za-z0-9_$])`
const directSqlWriter = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?${qualifiedArenaBots}`,
  'i'
)
const queryBuilderWriter =
  /\.from\s*\(\s*(['"`])bots\1\s*\)\s*\.\s*(?:insert|upsert|update|delete)\s*\(/i
const legacyPublisher = /\bpublishBots\b|publish-bots/
const positionHistoryRelation = String.raw`(?:(?:"arena"|arena)\s*\.\s*)?(?:"position_history"|position_history)(?![A-Za-z0-9_$])`
const directPositionHistoryWriter = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?${positionHistoryRelation}`,
  'i'
)
const positionHistoryQueryBuilderWriter =
  /\.from\s*\(\s*(['"`])position_history\1\s*\)\s*\.\s*(?:insert|upsert|update|delete)\s*\(/i
const retiredPositionHistorySqlReference =
  /(?:"arena"|arena)\s*\.\s*(?:"publish_verified_position_history"|publish_verified_position_history)(?![A-Za-z0-9_$])/i
const retiredPositionHistoryRpc = /\.\s*rpc\s*\(\s*(['"`])publish_verified_position_history\1/i
const retiredPositionHistoryPublisher = /\bpublishTierBVerifiedPositionHistoryInTransaction\b/i
const genericHistoryPublisherCall = /\bpublishHistoryRows(?:InTransaction)?\s*\(/m
const REVIEWED_GENERIC_HISTORY_CALLERS = new Set([
  'lib/ingest/serving/publish.ts',
  'scripts/ingest-test-surfaces.ts',
  'worker/src/ingest/processors/tier-b-profiles.ts',
  'worker/src/ingest/processors/tier-c-profile.ts',
])

function hasArenaBotsWriter(source) {
  return (
    directSqlWriter.test(source) || queryBuilderWriter.test(source) || legacyPublisher.test(source)
  )
}

function hasPositionHistoryBypass(source) {
  return (
    directPositionHistoryWriter.test(source) ||
    positionHistoryQueryBuilderWriter.test(source) ||
    retiredPositionHistorySqlReference.test(source) ||
    retiredPositionHistoryRpc.test(source) ||
    retiredPositionHistoryPublisher.test(source)
  )
}

function productionSources(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const relativePath = relative(ROOT, path)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(name)) continue
      files.push(...productionSources(path))
      continue
    }
    if (
      SOURCE_EXTENSIONS.has(extname(name)) &&
      !/\.(?:fixture|spec|test)\.(?:js|mjs|mts|ts)$/.test(name)
    ) {
      files.push(relativePath)
    }
  }
  return files
}

test('writer detector covers SQL, quoted SQL, query builders, and the retired publisher', () => {
  for (const writer of [
    'INSERT INTO arena.bots (source_id) VALUES (1)',
    'UPDATE ONLY "arena" . "bots" SET pair = $1',
    'DELETE FROM arena . bots WHERE source_id = $1',
    'MERGE INTO "arena"."bots" AS target USING incoming ON true',
    'TRUNCATE TABLE arena.bots',
    "client.schema('arena').from('bots').upsert(rows)",
    'client\n  .from("bots")\n  .delete()',
    "export function Action() {\n  return db.from('bots')\n    .update({ enabled: false })\n}",
    "import { publishBots } from './publish-bots'",
  ]) {
    assert.equal(hasArenaBotsWriter(writer), true, `writer fixture was missed: ${writer}`)
  }
  for (const reader of [
    'SELECT * FROM arena.bots',
    "client.schema('arena').from('bots').select('*')",
    "client.from('robots').update({ enabled: true })",
  ]) {
    assert.equal(hasArenaBotsWriter(reader), false, `reader fixture was misclassified: ${reader}`)
  }
})

test('repository production TS/JS has no arena.bots writer or legacy publisher', () => {
  const offenders = []
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = resolve(ROOT, sourceRoot)
    if (!existsSync(absoluteRoot)) continue
    for (const file of productionSources(absoluteRoot)) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      if (hasArenaBotsWriter(source)) offenders.push(file)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `arena.bots must remain a read-only legacy table; direct writers found: ${offenders.join(', ')}`
  )
})

test('position-history bypass detector covers direct DML and the retired RPC helper', () => {
  for (const writer of [
    'INSERT INTO arena.position_history (trader_id) VALUES (1)',
    'UPDATE ONLY "arena" . "position_history" SET raw = $1',
    'DELETE FROM arena . position_history WHERE trader_id = $1',
    'MERGE INTO "arena"."position_history" AS target USING incoming ON true',
    'TRUNCATE TABLE arena.position_history',
    'INSERT INTO position_history (trader_id) VALUES (1)',
    'UPDATE "position_history" SET raw = $1',
    "client.from('position_history').upsert(rows)",
    'publishTierBVerifiedPositionHistoryInTransaction(transaction, input)',
    'SELECT arena.publish_verified_position_history($1, $2, $3, $4, $5, $6)',
    'SELECT "arena" . "publish_verified_position_history"($1, $2)',
    "client.rpc('publish_verified_position_history', input)",
    'client\n  .rpc(\n    "publish_verified_position_history",\n    input\n  )',
    'client.rpc(`publish_verified_position_history`, input)',
  ]) {
    assert.equal(hasPositionHistoryBypass(writer), true, `writer fixture was missed: ${writer}`)
  }
  for (const reader of [
    'SELECT * FROM arena.position_history',
    'SELECT * FROM position_history',
    "client.from('position_history').select('*')",
    "client.rpc('get_position_history_publication_checkpoint', input)",
    "client.from('trader_position_history').update({ raw: null })",
  ]) {
    assert.equal(
      hasPositionHistoryBypass(reader),
      false,
      `reader fixture was misclassified: ${reader}`
    )
  }
})

test('repository production TS/JS has no direct or retired position-history writer', () => {
  const offenders = []
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = resolve(ROOT, sourceRoot)
    if (!existsSync(absoluteRoot)) continue
    for (const file of productionSources(absoluteRoot)) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      if (hasPositionHistoryBypass(source)) offenders.push(file)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `position_history requires parser-conservation publication; bypasses found: ${offenders.join(', ')}`
  )
})

test('generic history publication remains confined to reviewed non-position call sites', () => {
  const callers = []
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = resolve(ROOT, sourceRoot)
    if (!existsSync(absoluteRoot)) continue
    for (const file of productionSources(absoluteRoot)) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      if (genericHistoryPublisherCall.test(source)) callers.push(file)
    }
  }
  assert.deepEqual(callers.sort(), [...REVIEWED_GENERIC_HISTORY_CALLERS].sort())

  const manualSmoke = readFileSync(resolve(ROOT, 'scripts/ingest-test-surfaces.ts'), 'utf8')
  assert.match(manualSmoke, /for \(const kind of \['copiers'\] as const\)/)
  assert.doesNotMatch(
    manualSmoke,
    /for \(const kind of \[[^\]]*position_history[^\]]*\] as const\)/
  )
})
