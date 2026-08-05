#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  SOURCE_CATALOG_CONTRACT,
  SOURCE_CATALOG_KEYS,
  validateSourceCatalogRowContracts,
  validateSourceLedgerRowContracts,
} from './baseline-source-catalog-contract.mjs'
import { containsBaselineCredentialLikeData } from './baseline-credential-safety.mjs'
import {
  LAUNCH_MIGRATION_INVENTORY_CONTRACT,
  LAUNCH_MIGRATION_INVENTORY_STATUS,
  buildLaunchMigrationInventory,
  canonicalJsonSha256,
} from './launch-migration-inventory.mjs'

export const SOURCE_LAUNCH_RECONCILIATION_CONTRACT = 'arena.source-launch-ledger-reconciliation@1'
export const SOURCE_LAUNCH_RECONCILIATION_STATUS = 'analysis/read-only-not-live-evidence'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const VERSION_PATTERN = /^\d{14}$/u
const MIGRATION_FILE_PATTERN = /^(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/u
const MAX_SOURCE_CATALOG_BYTES = 64 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
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

function assertPlainObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    fail(`${label} must be an object`)
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(', ')}`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertPrintable(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must be a non-empty printable string`)
  }
}

function assertCanonicalObjectArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  let previous = null
  for (const [index, item] of value.entries()) {
    assertPlainObject(item, `${label}[${index}]`)
    const canonical = JSON.stringify(canonicalize(item))
    if (previous !== null && canonical <= previous) {
      fail(`${label} must be canonically sorted and contain no duplicates`)
    }
    previous = canonical
  }
}

function assertNoCredentialLikeData(contents) {
  if (containsBaselineCredentialLikeData(contents)) {
    fail('source-catalog.json contains credential-like data')
  }
}

export function validateSourceCatalogForReconciliation(document) {
  assertExactKeys(
    document,
    ['capturedAt', 'catalog', 'contract', 'ledger', 'postgresMajor'],
    'source-catalog.json'
  )
  if (document.contract !== SOURCE_CATALOG_CONTRACT) {
    fail(`source-catalog.json contract must be ${SOURCE_CATALOG_CONTRACT}`)
  }
  if (document.postgresMajor !== 17) fail('source-catalog.json postgresMajor must be 17')
  if (
    typeof document.capturedAt !== 'string' ||
    Number.isNaN(Date.parse(document.capturedAt)) ||
    new Date(document.capturedAt).toISOString() !== document.capturedAt
  ) {
    fail('source-catalog.json capturedAt must be an exact ISO-8601 UTC timestamp')
  }
  assertExactKeys(document.catalog, SOURCE_CATALOG_KEYS, 'source-catalog.json catalog')
  validateSourceCatalogRowContracts(document.catalog, { fail })
  for (const key of SOURCE_CATALOG_KEYS) {
    assertCanonicalObjectArray(document.catalog[key], `source-catalog.json catalog ${key}`)
  }
  assertCanonicalObjectArray(document.ledger, 'source-catalog.json ledger')
  validateSourceLedgerRowContracts(document.ledger, { fail })
  const modernVersions = new Set()
  for (const [index, row] of document.ledger.entries()) {
    const label = `source-catalog.json ledger[${index}]`
    if (VERSION_PATTERN.test(row.version)) {
      if (modernVersions.has(row.version)) {
        fail(`${label}.version duplicates modern source ledger version ${row.version}`)
      }
      modernVersions.add(row.version)
    }
  }
  if (modernVersions.size === 0) {
    fail('source-catalog.json ledger must contain a modern 14-digit baseline boundary')
  }
  return document
}

function validateInventory(inventory) {
  assertExactKeys(
    inventory,
    ['contract', 'inventorySha256', 'phases', 'source', 'status'],
    'launch migration inventory'
  )
  const { inventorySha256, ...attested } = inventory
  assertSha256(inventorySha256, 'launch migration inventory inventorySha256')
  if (canonicalJsonSha256(attested) !== inventorySha256) {
    fail('launch migration inventory digest does not match its contents')
  }
  if (inventory.contract !== LAUNCH_MIGRATION_INVENTORY_CONTRACT) {
    fail(`launch migration inventory contract must be ${LAUNCH_MIGRATION_INVENTORY_CONTRACT}`)
  }
  if (inventory.status !== LAUNCH_MIGRATION_INVENTORY_STATUS) {
    fail(`launch migration inventory status must be ${LAUNCH_MIGRATION_INVENTORY_STATUS}`)
  }
  assertExactKeys(inventory.source, ['path', 'sha256'], 'launch migration inventory source')
  if (inventory.source.path !== 'scripts/maintenance/apply-launch-migrations.sh') {
    fail('launch migration inventory source path is invalid')
  }
  assertSha256(inventory.source.sha256, 'launch migration inventory source sha256')
  if (!Array.isArray(inventory.phases)) fail('launch migration inventory phases must be an array')
  const phaseNames = new Set()
  for (const [phaseIndex, phase] of inventory.phases.entries()) {
    const phaseLabel = `launch migration inventory phases[${phaseIndex}]`
    assertExactKeys(
      phase,
      ['count', 'migrationSetSha256', 'migrations', 'name', 'sourceArray'],
      phaseLabel
    )
    assertPrintable(phase.name, `${phaseLabel}.name`)
    assertPrintable(phase.sourceArray, `${phaseLabel}.sourceArray`)
    if (phaseNames.has(phase.name)) fail(`launch migration phase is duplicated: ${phase.name}`)
    phaseNames.add(phase.name)
    if (
      !Number.isInteger(phase.count) ||
      phase.count < 0 ||
      phase.count !== phase.migrations.length
    ) {
      fail(`${phaseLabel}.count does not match migrations`)
    }
    assertSha256(phase.migrationSetSha256, `${phaseLabel}.migrationSetSha256`)
    if (canonicalJsonSha256(phase.migrations) !== phase.migrationSetSha256) {
      fail(`${phaseLabel}.migrationSetSha256 does not match migrations`)
    }
    const versions = new Set()
    for (const [migrationIndex, migration] of phase.migrations.entries()) {
      const migrationLabel = `${phaseLabel}.migrations[${migrationIndex}]`
      assertExactKeys(
        migration,
        ['file', 'ledgerStatementsSha256', 'name', 'path', 'sha256', 'version'],
        migrationLabel
      )
      const match = MIGRATION_FILE_PATTERN.exec(migration.file)
      if (!match) fail(`${migrationLabel}.file is invalid`)
      if (
        migration.version !== match[1] ||
        migration.name !== match[2] ||
        migration.path !== `supabase/migrations/${migration.file}`
      ) {
        fail(`${migrationLabel} identity fields do not agree`)
      }
      if (versions.has(migration.version)) {
        fail(`${phaseLabel} duplicates migration version ${migration.version}`)
      }
      versions.add(migration.version)
      assertSha256(migration.sha256, `${migrationLabel}.sha256`)
      assertSha256(migration.ledgerStatementsSha256, `${migrationLabel}.ledgerStatementsSha256`)
    }
  }
  return inventory
}

function selectExpectedMigrations(inventory, requestedPhases) {
  if (!Array.isArray(requestedPhases) || requestedPhases.length === 0) {
    fail('at least one launch migration phase is required')
  }
  const requested = new Set()
  for (const phase of requestedPhases) {
    assertPrintable(phase, 'launch migration phase')
    if (requested.has(phase)) fail(`launch migration phase is duplicated: ${phase}`)
    requested.add(phase)
  }
  const selected = inventory.phases.filter((phase) => requested.has(phase.name))
  for (const phase of requested) {
    if (!selected.some((candidate) => candidate.name === phase)) {
      fail(`launch migration phase is unknown: ${phase}`)
    }
  }
  const byVersion = new Map()
  for (const phase of selected) {
    for (const migration of phase.migrations) {
      const existing = byVersion.get(migration.version)
      if (existing) {
        if (
          existing.file !== migration.file ||
          existing.sha256 !== migration.sha256 ||
          existing.ledgerStatementsSha256 !== migration.ledgerStatementsSha256
        ) {
          fail(`selected phases disagree about migration version ${migration.version}`)
        }
        existing.phases.push(phase.name)
      } else {
        byVersion.set(migration.version, { ...migration, phases: [phase.name] })
      }
    }
  }
  return [...byVersion.values()].sort((left, right) => left.version.localeCompare(right.version))
}

function expectedLedgerIdentity(expected) {
  return {
    createdBy: 'codex',
    idempotencyKey: `codex:${expected.version}:${expected.sha256}`,
    name: expected.name,
    statementsSha256: expected.ledgerStatementsSha256,
  }
}

function relatedRowsFor(expected, expectedIdentity, modernLedger) {
  return modernLedger.filter(
    (row) =>
      row.version !== expected.version &&
      (row.name === expectedIdentity.name ||
        row.statementsSha256 === expectedIdentity.statementsSha256 ||
        row.idempotencyKey === expectedIdentity.idempotencyKey)
  )
}

function ledgerIdentityMismatches(expected, expectedIdentity, observed) {
  const mismatches = []
  if (observed.version !== expected.version) mismatches.push('version')
  if (observed.name !== expectedIdentity.name) mismatches.push('name')
  if (observed.statementsSha256 !== expectedIdentity.statementsSha256) {
    mismatches.push('statementsSha256')
  }
  if (observed.createdBy !== expectedIdentity.createdBy) mismatches.push('createdBy')
  if (observed.idempotencyKey !== expectedIdentity.idempotencyKey) {
    mismatches.push('idempotencyKey')
  }
  return mismatches
}

export function reconcileSourceLedger({ inventory, phaseNames = ['predeploy'], sourceCatalog }) {
  validateInventory(inventory)
  validateSourceCatalogForReconciliation(sourceCatalog)
  assertNoCredentialLikeData(JSON.stringify(sourceCatalog))
  const expectedMigrations = selectExpectedMigrations(inventory, phaseNames)
  const modernLedger = sourceCatalog.ledger.filter((row) => VERSION_PATTERN.test(row.version))
  const ledgerByVersion = new Map(modernLedger.map((row) => [row.version, row]))
  const results = expectedMigrations.map((expected) => {
    const expectedIdentity = expectedLedgerIdentity(expected)
    const observed = ledgerByVersion.get(expected.version)
    if (!observed) {
      const relatedLedger = relatedRowsFor(expected, expectedIdentity, modernLedger)
      const relatedMismatches = [
        ...new Set(
          relatedLedger.flatMap((row) => ledgerIdentityMismatches(expected, expectedIdentity, row))
        ),
      ]
      return {
        classification: relatedLedger.length === 0 ? 'missing' : 'drift',
        expected: expectedIdentity,
        file: expected.file,
        mismatches: relatedLedger.length === 0 ? ['version'] : relatedMismatches,
        observed: null,
        phases: expected.phases,
        relatedLedger,
        version: expected.version,
      }
    }
    const mismatches = ledgerIdentityMismatches(expected, expectedIdentity, observed)
    return {
      classification: mismatches.length === 0 ? 'exact' : 'drift',
      expected: expectedIdentity,
      file: expected.file,
      mismatches,
      observed,
      phases: expected.phases,
      relatedLedger: [],
      version: expected.version,
    }
  })
  const expectedVersions = new Set(expectedMigrations.map((migration) => migration.version))
  const unknownLedger = modernLedger.filter((row) => !expectedVersions.has(row.version))
  const exact = results.filter((result) => result.classification === 'exact').length
  const missing = results.filter((result) => result.classification === 'missing').length
  const drift = results.filter((result) => result.classification === 'drift').length
  const summary = {
    drift,
    exact,
    expected: results.length,
    missing,
    sourceLedgerModern: modernLedger.length,
    unknown: unknownLedger.length,
  }
  const attested = {
    contract: SOURCE_LAUNCH_RECONCILIATION_CONTRACT,
    inventory: {
      inventorySha256: inventory.inventorySha256,
      phases: inventory.phases
        .filter((phase) => phaseNames.includes(phase.name))
        .map((phase) => phase.name),
    },
    outcome: missing === 0 && drift === 0 ? 'exact' : 'incomplete',
    results,
    semantics: {
      drift:
        'same or related ledger identity exists but name, statement digest, creator, and/or idempotency key differs',
      exact:
        'version, name, captured statement-array digest, creator codex, and raw-file-bound idempotency key match',
      missing: 'selected launch version has no same or related modern source-ledger row',
      unknown:
        'modern source-ledger row is outside the selected launch phases and is not a gap decision',
    },
    source: {
      capturedAt: sourceCatalog.capturedAt,
      catalogSha256: canonicalJsonSha256(sourceCatalog.catalog),
      ledgerSha256: canonicalJsonSha256(sourceCatalog.ledger),
    },
    status: SOURCE_LAUNCH_RECONCILIATION_STATUS,
    summary,
    unknownLedger,
  }
  return Object.freeze({
    ...attested,
    reconciliationSha256: canonicalJsonSha256(attested),
  })
}

function readPrivateSourceCatalog(inputPath) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    fail('source catalog path must be absolute')
  }
  const lexicalPath = path.resolve(inputPath)
  let metadata
  let physicalPath
  try {
    metadata = lstatSync(lexicalPath)
    physicalPath = realpathSync(lexicalPath)
  } catch {
    fail('source catalog is unavailable')
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || physicalPath !== lexicalPath) {
    fail('source catalog must be a canonical regular file without symlink components')
  }
  const effectiveUserId = typeof process.geteuid === 'function' ? process.geteuid() : null
  const parentPath = path.dirname(physicalPath)
  const parentMetadata = lstatSync(parentPath)
  if (
    effectiveUserId === null ||
    metadata.uid !== effectiveUserId ||
    (metadata.mode & 0o077) !== 0
  ) {
    fail('source catalog must be owner-only')
  }
  if (
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    parentMetadata.uid !== effectiveUserId ||
    (parentMetadata.mode & 0o077) !== 0 ||
    realpathSync(parentPath) !== parentPath
  ) {
    fail('source catalog parent must be owner-only')
  }
  if (metadata.size > MAX_SOURCE_CATALOG_BYTES) fail('source catalog exceeds size limit')
  let descriptor
  let contents
  try {
    if (typeof fsConstants.O_NOFOLLOW !== 'number') {
      fail('source catalog cannot be read safely without O_NOFOLLOW')
    }
    descriptor = openSync(physicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = fstatSync(descriptor)
    if (
      !before.isFile() ||
      before.dev !== metadata.dev ||
      before.ino !== metadata.ino ||
      before.uid !== effectiveUserId ||
      (before.mode & 0o077) !== 0 ||
      before.size > MAX_SOURCE_CATALOG_BYTES
    ) {
      fail('source catalog changed while opening')
    }
    contents = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor)
    const finalMetadata = lstatSync(physicalPath)
    const finalParentMetadata = lstatSync(parentPath)
    for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
      if (before[field] !== after[field] || after[field] !== finalMetadata[field]) {
        fail('source catalog changed while reading')
      }
    }
    if (
      finalMetadata.isSymbolicLink() ||
      !finalMetadata.isFile() ||
      realpathSync(physicalPath) !== physicalPath
    ) {
      fail('source catalog changed while reading')
    }
    if (
      finalParentMetadata.isSymbolicLink() ||
      !finalParentMetadata.isDirectory() ||
      finalParentMetadata.dev !== parentMetadata.dev ||
      finalParentMetadata.ino !== parentMetadata.ino ||
      finalParentMetadata.uid !== effectiveUserId ||
      (finalParentMetadata.mode & 0o077) !== 0 ||
      realpathSync(parentPath) !== parentPath
    ) {
      fail('source catalog parent changed while reading')
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  assertNoCredentialLikeData(contents)
  let document
  try {
    document = JSON.parse(contents)
  } catch {
    fail('source catalog is not valid JSON')
  }
  return validateSourceCatalogForReconciliation(document)
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  let sourceCatalogPath = null
  const phaseNames = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source-catalog' && index + 1 < argv.length) {
      if (sourceCatalogPath !== null) fail('--source-catalog may be specified only once')
      sourceCatalogPath = argv[(index += 1)]
    } else if (argument === '--phase' && index + 1 < argv.length) {
      phaseNames.push(argv[(index += 1)])
    } else {
      fail('arguments are invalid')
    }
  }
  if (sourceCatalogPath === null) fail('--source-catalog is required')
  return {
    help: false,
    phaseNames: phaseNames.length === 0 ? ['predeploy'] : phaseNames,
    sourceCatalogPath,
  }
}

function usage() {
  return [
    'Usage: node scripts/qa/source-launch-ledger-reconciliation.mjs',
    '  --source-catalog /canonical/private/source-catalog.json [--phase predeploy]',
  ].join('\n')
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv)
    if (options.help) {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    const report = reconcileSourceLedger({
      inventory: buildLaunchMigrationInventory(),
      phaseNames: options.phaseNames,
      sourceCatalog: readPrivateSourceCatalog(options.sourceCatalogPath),
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.outcome !== 'exact') {
      process.stderr.write('Source/launch ledger reconciliation is incomplete.\n')
      return 1
    }
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Source/launch ledger reconciliation refused: ${message}\n`)
    return 2
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) process.exitCode = runCli()
