import { createHash } from 'node:crypto'

import {
  SOURCE_CATALOG_CONTRACT,
  SOURCE_CATALOG_KEYS,
  validateSourceCatalogRowContracts,
  validateSourceLedgerRowContracts,
} from './baseline-source-catalog-contract.mjs'

export const BASELINE_REPLAY_TARGET_WITNESS_CONTRACT =
  'arena.canonical-baseline-replay-target-witness@1'
export const BASELINE_REPLAY_COMPARISON_CONTRACT = 'arena.canonical-baseline-replay-comparison@1'
export const BASELINE_REPLAY_WITNESS_STATUS = 'dependency-witness/not-promotion-evidence'

const FORWARD_MIGRATIONS_CONTRACT = 'arena.canonical-baseline-forward-migrations@1'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const VERSION_PATTERN = /^\d{14}$/u
const FORWARD_PATH_PATTERN = /^supabase\/migrations\/(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/u
const PUBLICATION_KEY = 'publications'
const COMPARABLE_CATALOG_KEYS = Object.freeze(
  SOURCE_CATALOG_KEYS.filter((key) => key !== PUBLICATION_KEY)
)

function fail(message) {
  throw new Error(message)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function canonicalReplayWitnessSha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function assertPlainObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    fail(`${label} must be an object`)
  }
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(', ')}`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertCanonicalObjectArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  let previous = null
  for (const [index, row] of value.entries()) {
    assertPlainObject(row, `${label}[${index}]`)
    const current = canonicalJson(row)
    if (previous !== null && current <= previous) {
      fail(`${label} must be canonically sorted and contain no duplicates`)
    }
    previous = current
  }
}

function validateCatalog(catalog, label) {
  assertExactKeys(catalog, SOURCE_CATALOG_KEYS, label)
  validateSourceCatalogRowContracts(catalog, {
    fail: (message) => fail(`${label}: ${message}`),
  })
  for (const key of SOURCE_CATALOG_KEYS) {
    assertCanonicalObjectArray(catalog[key], `${label}.${key}`)
  }
}

function validateLedger(ledger) {
  assertCanonicalObjectArray(ledger, 'source-catalog.json ledger')
  validateSourceLedgerRowContracts(ledger, { fail })
  const modernVersions = []
  const seenModernVersions = new Set()
  for (const [index, row] of ledger.entries()) {
    const label = `source-catalog.json ledger[${index}]`
    if (VERSION_PATTERN.test(row.version)) {
      if (seenModernVersions.has(row.version)) {
        fail(`${label}.version duplicates modern source ledger version ${row.version}`)
      }
      seenModernVersions.add(row.version)
      modernVersions.push(row.version)
    }
  }
  if (modernVersions.length === 0) {
    fail('source-catalog.json ledger must contain a modern 14-digit baseline boundary')
  }
  modernVersions.sort()
  return modernVersions.at(-1)
}

function validateSourceDocument(source) {
  assertExactKeys(
    source,
    ['capturedAt', 'catalog', 'contract', 'ledger', 'postgresMajor'],
    'source-catalog.json'
  )
  if (source.contract !== SOURCE_CATALOG_CONTRACT) {
    fail(`source-catalog.json contract must be ${SOURCE_CATALOG_CONTRACT}`)
  }
  if (source.postgresMajor !== 17) fail('source-catalog.json postgresMajor must be 17')
  if (
    typeof source.capturedAt !== 'string' ||
    Number.isNaN(Date.parse(source.capturedAt)) ||
    new Date(source.capturedAt).toISOString() !== source.capturedAt
  ) {
    fail('source-catalog.json capturedAt must be an exact ISO-8601 UTC timestamp')
  }
  validateCatalog(source.catalog, 'source-catalog.json catalog')
  return validateLedger(source.ledger)
}

function validateForwardManifest(forward, latestSourceVersion) {
  assertExactKeys(
    forward,
    [
      'baselineThrough',
      'contract',
      'migrationSetSha256',
      'migrations',
      'repositoryMigrationSetSha256',
    ],
    'forward-migrations.json'
  )
  if (forward.contract !== FORWARD_MIGRATIONS_CONTRACT) {
    fail(`forward-migrations.json contract must be ${FORWARD_MIGRATIONS_CONTRACT}`)
  }
  if (forward.baselineThrough !== latestSourceVersion) {
    fail(
      'forward-migrations.json baselineThrough must equal the latest modern source ledger version'
    )
  }
  assertSha256(forward.migrationSetSha256, 'forward-migrations.json migrationSetSha256')
  assertSha256(
    forward.repositoryMigrationSetSha256,
    'forward-migrations.json repositoryMigrationSetSha256'
  )
  if (!Array.isArray(forward.migrations))
    fail('forward-migrations.json migrations must be an array')
  if (canonicalReplayWitnessSha256(forward.migrations) !== forward.migrationSetSha256) {
    fail('forward-migrations.json migrationSetSha256 does not match migrations')
  }
  let previousVersion = forward.baselineThrough
  for (const [index, migration] of forward.migrations.entries()) {
    const label = `forward-migrations.json migrations[${index}]`
    assertExactKeys(migration, ['path', 'sha256', 'version'], label)
    if (typeof migration.version !== 'string' || !VERSION_PATTERN.test(migration.version)) {
      fail(`${label}.version must be a 14-digit version`)
    }
    if (migration.version <= previousVersion) {
      fail('forward migration versions must be strictly increasing and newer than baselineThrough')
    }
    const match =
      typeof migration.path === 'string' ? migration.path.match(FORWARD_PATH_PATTERN) : null
    if (!match || match[1] !== migration.version) {
      fail(`${label}.path must be a matching repo-relative modern migration path`)
    }
    assertSha256(migration.sha256, `${label}.sha256`)
    previousVersion = migration.version
  }
}

function validateTargetWitness(target) {
  assertExactKeys(
    target,
    [
      'baselineCatalog',
      'contract',
      'finalCatalog',
      'forwardExecutions',
      'postgresMajor',
      'source',
      'status',
    ],
    'target witness'
  )
  if (target.contract !== BASELINE_REPLAY_TARGET_WITNESS_CONTRACT) {
    fail(`target witness contract must be ${BASELINE_REPLAY_TARGET_WITNESS_CONTRACT}`)
  }
  if (target.status !== BASELINE_REPLAY_WITNESS_STATUS) {
    fail(`target witness status must remain ${BASELINE_REPLAY_WITNESS_STATUS}`)
  }
  if (target.postgresMajor !== 17) fail('target witness postgresMajor must be 17')
  assertExactKeys(
    target.source,
    ['baselineThrough', 'catalogSha256', 'ledgerSha256'],
    'target witness source'
  )
  if (
    typeof target.source.baselineThrough !== 'string' ||
    !VERSION_PATTERN.test(target.source.baselineThrough)
  ) {
    fail('target witness source baselineThrough must be a 14-digit version')
  }
  assertSha256(target.source.catalogSha256, 'target witness source catalogSha256')
  assertSha256(target.source.ledgerSha256, 'target witness source ledgerSha256')
  validateCatalog(target.baselineCatalog, 'target witness baselineCatalog')
  validateCatalog(target.finalCatalog, 'target witness finalCatalog')
  if (!Array.isArray(target.forwardExecutions)) {
    fail('target witness forwardExecutions must be an array')
  }
  for (const [index, execution] of target.forwardExecutions.entries()) {
    const label = `target witness forwardExecutions[${index}]`
    assertExactKeys(execution, ['path', 'sha256', 'version'], label)
    if (typeof execution.version !== 'string' || !VERSION_PATTERN.test(execution.version)) {
      fail(`${label}.version must be a 14-digit version`)
    }
    const match =
      typeof execution.path === 'string' ? execution.path.match(FORWARD_PATH_PATTERN) : null
    if (!match || match[1] !== execution.version) {
      fail(`${label}.path must be a matching repo-relative modern migration path`)
    }
    assertSha256(execution.sha256, `${label}.sha256`)
  }
}

function assertJsonEqual(actual, expected, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(message)
}

function catalogDelta(before, after) {
  return Object.fromEntries(
    SOURCE_CATALOG_KEYS.map((key) => {
      const beforeRows = new Map(before[key].map((row) => [canonicalJson(row), row]))
      const afterRows = new Map(after[key].map((row) => [canonicalJson(row), row]))
      const removed = [...beforeRows]
        .filter(([canonical]) => !afterRows.has(canonical))
        .map(([, row]) => row)
      const added = [...afterRows]
        .filter(([canonical]) => !beforeRows.has(canonical))
        .map(([, row]) => row)
      return [
        key,
        {
          addedCount: added.length,
          addedSha256: canonicalReplayWitnessSha256(added),
          removedCount: removed.length,
          removedSha256: canonicalReplayWitnessSha256(removed),
        },
      ]
    })
  )
}

export function compareBaselineReplayWitness({
  forwardManifest,
  sourceCatalog,
  targetWitness,
} = {}) {
  const latestSourceVersion = validateSourceDocument(sourceCatalog)
  validateForwardManifest(forwardManifest, latestSourceVersion)
  validateTargetWitness(targetWitness)

  if (targetWitness.source.baselineThrough !== forwardManifest.baselineThrough) {
    fail('target witness source baselineThrough does not match forward-migrations.json')
  }
  if (targetWitness.source.catalogSha256 !== canonicalReplayWitnessSha256(sourceCatalog.catalog)) {
    fail('target witness source catalogSha256 does not match source-catalog.json')
  }
  if (targetWitness.source.ledgerSha256 !== canonicalReplayWitnessSha256(sourceCatalog.ledger)) {
    fail('target witness source ledgerSha256 does not match source-catalog.json')
  }

  for (const key of COMPARABLE_CATALOG_KEYS) {
    assertJsonEqual(
      targetWitness.baselineCatalog[key],
      sourceCatalog.catalog[key],
      `target baseline catalog ${key} does not match the captured source boundary`
    )
  }
  if (targetWitness.baselineCatalog.publications.length !== 0) {
    fail('target baseline catalog contains undeclared publications')
  }

  assertJsonEqual(
    targetWitness.forwardExecutions,
    forwardManifest.migrations,
    'target forward execution ledger does not exactly match forward-migrations.json'
  )
  if (forwardManifest.migrations.length === 0) {
    assertJsonEqual(
      targetWitness.finalCatalog,
      targetWitness.baselineCatalog,
      'target final catalog changed without a declared forward migration'
    )
  }

  const delta = catalogDelta(targetWitness.baselineCatalog, targetWitness.finalCatalog)
  const changedCatalogKeys = SOURCE_CATALOG_KEYS.filter(
    (key) => delta[key].addedCount !== 0 || delta[key].removedCount !== 0
  )

  return {
    contract: BASELINE_REPLAY_COMPARISON_CONTRACT,
    status: BASELINE_REPLAY_WITNESS_STATUS,
    postgresMajor: 17,
    sourceBoundary: {
      comparableCatalogKeyCount: COMPARABLE_CATALOG_KEYS.length,
      comparableCatalogMatched: true,
      publicationEvidenceCount: sourceCatalog.catalog.publications.length,
      publicationsReplayed: false,
      sourceCatalogSha256: targetWitness.source.catalogSha256,
      sourceLedgerDigestAnchored: true,
      sourceLedgerSha256: targetWitness.source.ledgerSha256,
    },
    forward: {
      changedCatalogKeys,
      executionCount: targetWitness.forwardExecutions.length,
      executionLedgerMatched: true,
      observedCatalogDelta: delta,
    },
    finalCatalogApproved: false,
    managedSupabaseEquivalent: false,
    productionEquivalent: false,
    promotionEvidence: false,
  }
}
