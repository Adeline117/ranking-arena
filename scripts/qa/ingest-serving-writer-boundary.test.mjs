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
const directServingPublisher = /\b(?:publishProfile|publishPositions|publishHistoryRows)\b/

function hasArenaBotsWriter(source) {
  return (
    directSqlWriter.test(source) || queryBuilderWriter.test(source) || legacyPublisher.test(source)
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

test('operator scripts cannot bypass region queues into serving publishers', () => {
  const scriptsRoot = resolve(ROOT, 'scripts')
  const offenders = productionSources(scriptsRoot).filter((file) => {
    const source = readFileSync(resolve(ROOT, file), 'utf8')
    return directServingPublisher.test(source)
  })

  assert.deepEqual(
    offenders,
    [],
    `operator scripts must enqueue region-owned jobs instead of mutating serving: ${offenders.join(', ')}`
  )
})
