import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  '__integration__',
  '__tests__',
  'fixtures',
  'node_modules',
  'test-results',
  'tests',
])

function productionSources(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(name)) files.push(...productionSources(path))
      continue
    }
    if (
      SOURCE_EXTENSIONS.has(extname(name)) &&
      !/\.(?:fixture|spec|test)\.(?:js|jsx|mjs|mts|ts|tsx)$/.test(name)
    ) {
      files.push(relative(ROOT, path))
    }
  }
  return files
}

test('Tier-A publication and attempt clients expose claimed transaction paths only', () => {
  const publication = read('worker/src/ingest/fenced-tier-a-publication.ts')
  for (const name of [
    'publishClaimedTrustedLeaderboardSnapshot',
    'publishClaimedAttemptBoundLeaderboardSnapshot',
    'publishClaimedBoardSeries',
  ]) {
    assert.match(publication, new RegExp(`export async function ${name}\\(`))
  }
  assert.doesNotMatch(publication, /\bpublishFenced[A-Za-z]+\b|\bwithFencedTierAPublication\b/)
  // Publication requires attempt-bound evidence: no count-check-only snapshot path.
  assert.doesNotMatch(publication, /\bpublishClaimedLeaderboardSnapshot\b/)

  const attempts = read('lib/ingest/acquisition-attempts.ts')
  assert.match(attempts, /export async function startLeaderboardAcquisitionAttemptInTransaction\(/)
  assert.match(attempts, /export async function finishLeaderboardAcquisitionAttemptInTransaction\(/)
  assert.doesNotMatch(attempts, /export async function startLeaderboardAcquisitionAttempt\(/)
  assert.doesNotMatch(attempts, /export async function finishLeaderboardAcquisitionAttempt\(/)
  assert.doesNotMatch(attempts, /\b(?:START_SQL|FINISH_SQL|exactReplayQuery|replayed)\b/)
})

test('Tier-A RAW and field inventory writes require caller-owned authority', () => {
  const raw = read('lib/ingest/raw.ts')
  assert.match(
    raw,
    /writeAttemptBoundLeaderboardRawArtifactSet\([\s\S]*?runTransaction: IngestTransactionRunner[\s\S]*?assertTierARawTransactionRunner\(runTransaction\)/
  )
  assert.doesNotMatch(raw, /async function persistLeaderboardTrustPointers\(/)
  assert.doesNotMatch(raw, /async function reconcileLeaderboardTrustCommit\(/)

  const guardIndex = raw.indexOf('TIER_A_RAW_JOB_TYPES.has(input.jobType)')
  const uploadIndex = raw.indexOf('await uploadRawPayload(storagePath, gz)', guardIndex)
  assert.ok(guardIndex >= 0, 'generic RAW writer must classify Tier-A job types')
  assert.ok(uploadIndex > guardIndex, 'Tier-A runner guard must execute before Storage upload')

  const inventory = read('lib/ingest/field-inventory.ts')
  assert.match(inventory, /JobType extends 'tier_a' \? never : JobType/)
  assert.match(inventory, /if \(jobType === 'tier_a'\)[\s\S]*?requires a claimed executor/)
  assert.match(inventory, /recordFieldInventoryWithExecutor\(getIngestPool\(\)/)
})

test('direct serving publication is derived-only and legacy direct names have no production callers', () => {
  const publish = read('lib/ingest/serving/publish.ts')
  assert.match(publish, /export async function publishDerivedLeaderboardSnapshot\(/)
  assert.match(
    publish,
    /publishDerivedLeaderboardSnapshotInternal\(\{[\s\S]*?rawObjectId: null,[\s\S]*?isDerived: true,[\s\S]*?preparedTrust: null/
  )
  assert.match(publish, /requires a declared derived-only timeframe/)
  assert.doesNotMatch(publish, /export async function publishLeaderboardSnapshot\(/)
  assert.doesNotMatch(publish, /export async function publishTrustedLeaderboardSnapshot\(/)
  assert.doesNotMatch(publish, /export async function publishBoardSeries\(/)

  const deriveBoards = read('worker/src/ingest/processors/derive-boards.ts')
  assert.match(deriveBoards, /publishDerivedLeaderboardSnapshot\(\{/)
  assert.doesNotMatch(deriveBoards, /\b(?:rawObjectId|isDerived)\s*:/)

  const forbidden = [
    'publishFencedLeaderboardSnapshot',
    'publishFencedTrustedLeaderboardSnapshot',
    'publishFencedAttemptBoundLeaderboardSnapshot',
    'publishFencedBoardSeries',
    'publishLeaderboardSnapshot',
    'publishTrustedLeaderboardSnapshot',
    'publishBoardSeries',
    'startLeaderboardAcquisitionAttempt',
    'finishLeaderboardAcquisitionAttempt',
  ]
  const offenders = []
  for (const root of ['lib', 'worker', 'scripts']) {
    for (const file of productionSources(resolve(ROOT, root))) {
      const source = read(file)
      for (const name of forbidden) {
        if (new RegExp(`\\b${name}\\b`).test(source)) offenders.push(`${file}: ${name}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
