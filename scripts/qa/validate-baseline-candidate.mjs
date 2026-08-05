#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { containsBaselineCredentialLikeData } from './baseline-credential-safety.mjs'
import {
  validateAppSchemaSqlSafety,
  validateFoundationSqlSafety,
  validateReplaySqlSafety,
} from './baseline-sql-safety.mjs'
import {
  SOURCE_CATALOG_CONTRACT,
  SOURCE_CATALOG_KEYS,
  validateSourceCatalogRowContracts,
  validateSourceLedgerRowContracts,
} from './baseline-source-catalog-contract.mjs'

export const BASELINE_CANDIDATE_CONTRACT = 'arena.canonical-baseline-candidate@1'
export const FORWARD_MIGRATIONS_CONTRACT = 'arena.canonical-baseline-forward-migrations@1'
export { SOURCE_CATALOG_CONTRACT }
export const PLATFORM_PREREQUISITES_CONTRACT = 'arena.canonical-baseline-platform-prerequisites@1'
export const FOUNDATION_CONTRACT = 'arena.disposable-supabase-foundation@1'
export const CANDIDATE_STATUS = 'candidate/not-deployable'
export const FOUNDATION_STATUS = 'fixture/not-production'

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_CANDIDATES_ROOT = path.join(SCRIPT_ROOT, 'supabase', 'baseline-candidates')
const REQUIRED_ARTIFACTS = Object.freeze([
  'app-schema.sql',
  'forward-migrations.json',
  'platform-prerequisites.json',
  'source-catalog.json',
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u
const VERSION_PATTERN = /^\d{14}$/u
const FORWARD_PATH_PATTERN = /^supabase\/migrations\/(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/u
const FOUNDATION_PATH_PATTERN = /^supabase\/baseline-foundations\/[a-z0-9][a-z0-9_-]*\.sql$/u
const CANDIDATE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])])
    )
  }
  return value
}

export function canonicalJsonSha256(value) {
  return sha256(JSON.stringify(canonicalizeJson(value)))
}

function fail(message) {
  throw new Error(message)
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

function parseJson(contents, label) {
  try {
    return JSON.parse(contents)
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`)
  }
}

function assertIsoTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${label} must be an exact ISO-8601 UTC timestamp`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertSortedUniqueStrings(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  let previous = null
  for (const [index, item] of value.entries()) {
    if (
      typeof item !== 'string' ||
      item.trim() !== item ||
      item.length === 0 ||
      /[\u0000-\u001f\u007f]/u.test(item)
    ) {
      fail(`${label}[${index}] must be a non-empty string without control characters`)
    }
    if (previous !== null && item <= previous) {
      fail(`${label} must be sorted and contain no duplicates`)
    }
    previous = item
  }
}

function assertCanonicalObjectArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  let previous = null
  for (const [index, item] of value.entries()) {
    assertPlainObject(item, `${label}[${index}]`)
    const canonical = JSON.stringify(canonicalizeJson(item))
    if (previous !== null && canonical <= previous) {
      fail(`${label} must be canonically sorted and contain no duplicates`)
    }
    previous = canonical
  }
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} must stay below ${root}`)
  }
  return relative
}

function effectiveUserId() {
  if (typeof process.geteuid !== 'function') {
    fail('effective user identity is unavailable; refusing to validate filesystem evidence')
  }
  const value = process.geteuid()
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('effective user identity is invalid; refusing to validate filesystem evidence')
  }
  return BigInt(value)
}

function statIdentity(stat) {
  if (
    typeof stat.dev !== 'bigint' ||
    typeof stat.ino !== 'bigint' ||
    typeof stat.uid !== 'bigint' ||
    typeof stat.mode !== 'bigint' ||
    typeof stat.size !== 'bigint' ||
    typeof stat.mtimeNs !== 'bigint' ||
    typeof stat.ctimeNs !== 'bigint'
  ) {
    fail('filesystem does not expose the metadata required for safe validation')
  }
  return Object.freeze({
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
    uid: stat.uid,
  })
}

const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'])

function sameIdentity(left, right) {
  return IDENTITY_KEYS.every((key) => left[key] === right[key])
}

function assertTrustedOwner(identity, label) {
  const euid = effectiveUserId()
  if (identity.uid !== 0n && identity.uid !== euid) {
    fail(`${label} must be owned by root or the effective user`)
  }
}

function permissionBits(identity) {
  return Number(identity.mode & 0o7777n)
}

function assertTrustedDirectoryStat(stat, label, { privateDirectory = false } = {}) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory, not a symlink`)
  }
  const identity = statIdentity(stat)
  assertTrustedOwner(identity, label)
  const permissions = permissionBits(identity)
  if (privateDirectory ? permissions !== 0o700 : (permissions & 0o7022) !== 0) {
    fail(
      privateDirectory
        ? `${label} must have exact 0700 permissions`
        : `${label} must not be group- or other-writable or carry special permission bits`
    )
  }
  return identity
}

function assertTrustedFileStat(stat, label, { privateFile = false } = {}) {
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
  const identity = statIdentity(stat)
  assertTrustedOwner(identity, label)
  const permissions = permissionBits(identity)
  if (privateFile ? permissions !== 0o600 : (permissions & 0o7022) !== 0) {
    fail(
      privateFile
        ? `${label} must have exact 0600 permissions`
        : `${label} must not be group- or other-writable or carry special permission bits`
    )
  }
  return identity
}

function assertPathComponentsAreTrusted(root, target, label) {
  const relative = assertInside(root, target, label)
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat
    try {
      stat = lstatSync(current, { bigint: true })
    } catch {
      fail(`${label} does not exist: ${current}`)
    }
    if (stat.isSymbolicLink()) fail(`${label} must not contain a symlink: ${current}`)
    if (current !== target) assertTrustedDirectoryStat(stat, `${label} parent directory`)
  }
}

function assertDirectoryRootIsNotSymlink(root, label) {
  let stat
  try {
    stat = lstatSync(root, { bigint: true })
  } catch {
    fail(`${label} does not exist: ${root}`)
  }
  return assertTrustedDirectoryStat(stat, label)
}

function callHook(testHooks, name, details) {
  const hook = testHooks?.[name]
  if (hook !== undefined && typeof hook !== 'function') fail(`test hook ${name} must be a function`)
  hook?.(Object.freeze({ ...details }))
}

function resolveSafeRelativePath(root, relativePath, label) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.includes('\0') ||
    relativePath.includes('\n') ||
    relativePath.includes('\r') ||
    path.isAbsolute(relativePath)
  ) {
    fail(`${label} has an unsafe path`)
  }
  const target = path.resolve(root, relativePath)
  assertInside(root, target, label)
  return target
}

function readPinnedRegularFile(root, relativePath, label, { privateFile = false, testHooks } = {}) {
  const target = resolveSafeRelativePath(root, relativePath, label)
  assertPathComponentsAreTrusted(root, target, label)
  let pathStat
  try {
    pathStat = lstatSync(target, { bigint: true })
  } catch {
    fail(`${label} does not exist`)
  }
  const before = assertTrustedFileStat(pathStat, label, { privateFile })
  callHook(testHooks, 'afterLstatBeforeOpen', { label, path: target })

  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    fail('O_NOFOLLOW is unavailable; refusing to validate filesystem evidence')
  }
  let descriptor
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    fail(`${label} could not be opened without following symbolic links`)
  }

  let opened
  let contents
  let after
  try {
    opened = assertTrustedFileStat(fstatSync(descriptor, { bigint: true }), label, {
      privateFile,
    })
    if (!sameIdentity(before, opened)) fail(`${label} changed while it was being opened`)
    contents = readFileSync(descriptor)
    if (BigInt(contents.length) !== opened.size)
      fail(`${label} size changed while it was being read`)
    callHook(testHooks, 'afterFdRead', { label, path: target })
    after = assertTrustedFileStat(fstatSync(descriptor, { bigint: true }), label, {
      privateFile,
    })
    if (!sameIdentity(opened, after)) fail(`${label} changed while it was being read`)
  } finally {
    closeSync(descriptor)
  }

  let finalPathStat
  try {
    finalPathStat = lstatSync(target, { bigint: true })
  } catch {
    fail(`${label} changed after it was read`)
  }
  const finalPathIdentity = assertTrustedFileStat(finalPathStat, label, { privateFile })
  if (!sameIdentity(after, finalPathIdentity)) fail(`${label} changed after it was read`)
  const record = {
    contents,
    identity: finalPathIdentity,
    label,
    path: target,
    privateFile,
    relativePath,
    root,
    sha256: sha256(contents),
  }
  callHook(testHooks, 'afterPinnedRead', { label, path: target, sha256: record.sha256 })
  return Object.freeze(record)
}

function readTrustedDirectory(target, label, { privateDirectory = false } = {}) {
  let stat
  try {
    stat = lstatSync(target, { bigint: true })
  } catch {
    fail(`${label} does not exist`)
  }
  const identity = assertTrustedDirectoryStat(stat, label, { privateDirectory })
  if (realpathSync(target) !== target) fail(`${label} must resolve to itself`)
  return Object.freeze({ identity, label, path: target, privateDirectory })
}

function assertDirectoryRecordUnchanged(record) {
  const current = readTrustedDirectory(record.path, record.label, {
    privateDirectory: record.privateDirectory,
  })
  if (!sameIdentity(record.identity, current.identity)) {
    fail(`${record.label} changed during candidate validation`)
  }
}

function assertPinnedPathUnchanged(record) {
  let stat
  try {
    stat = lstatSync(record.path, { bigint: true })
  } catch {
    fail(`${record.label} changed during candidate validation`)
  }
  const identity = assertTrustedFileStat(stat, record.label, {
    privateFile: record.privateFile,
  })
  if (!sameIdentity(record.identity, identity)) {
    fail(`${record.label} changed during candidate validation`)
  }
}

function reopenPinnedFile(record, testHooks) {
  const current = readPinnedRegularFile(record.root, record.relativePath, record.label, {
    privateFile: record.privateFile,
    testHooks,
  })
  if (!sameIdentity(record.identity, current.identity) || record.sha256 !== current.sha256) {
    fail(`${record.label} changed during candidate validation`)
  }
  return current
}

function validateNoSecrets(contents, label) {
  if (containsBaselineCredentialLikeData(contents)) {
    fail(`${label} contains a credential or connection identifier`)
  }
}

function validateForwardManifest(document, repoRoot, sourceLedger, { testHooks } = {}) {
  assertExactKeys(
    document,
    [
      'baselineThrough',
      'contract',
      'migrationSetSha256',
      'migrations',
      'repositoryMigrationSetSha256',
    ],
    'forward-migrations.json'
  )
  if (document.contract !== FORWARD_MIGRATIONS_CONTRACT) {
    fail(`forward-migrations.json contract must be ${FORWARD_MIGRATIONS_CONTRACT}`)
  }
  if (
    typeof document.baselineThrough !== 'string' ||
    !VERSION_PATTERN.test(document.baselineThrough)
  ) {
    fail('forward-migrations.json baselineThrough must be a 14-digit version')
  }
  assertSha256(document.migrationSetSha256, 'forward-migrations.json migrationSetSha256')
  assertSha256(
    document.repositoryMigrationSetSha256,
    'forward-migrations.json repositoryMigrationSetSha256'
  )
  if (!Array.isArray(document.migrations)) {
    fail('forward-migrations.json migrations must be an array')
  }
  if (canonicalJsonSha256(document.migrations) !== document.migrationSetSha256) {
    fail('forward-migrations.json migrationSetSha256 does not match migrations')
  }
  if (sourceLedger.modernVersions.length === 0) {
    fail('source-catalog.json ledger must contain a modern 14-digit baseline boundary')
  }
  const latestSourceVersion = sourceLedger.modernVersions.at(-1)
  if (document.baselineThrough !== latestSourceVersion) {
    fail(
      'forward-migrations.json baselineThrough must equal the latest unique 14-digit source ledger version'
    )
  }

  let previousVersion = null
  const seenPaths = new Set()
  const replayMigrations = []
  for (const [index, migration] of document.migrations.entries()) {
    const label = `forward-migrations.json migrations[${index}]`
    assertExactKeys(migration, ['path', 'sha256', 'version'], label)
    if (typeof migration.version !== 'string' || !VERSION_PATTERN.test(migration.version)) {
      fail(`${label}.version must be a 14-digit version`)
    }
    if (previousVersion !== null && migration.version <= previousVersion) {
      fail('forward migration versions must be strictly increasing')
    }
    if (migration.version <= document.baselineThrough) {
      fail(`${label}.version must be newer than baselineThrough`)
    }
    const match =
      typeof migration.path === 'string' ? migration.path.match(FORWARD_PATH_PATTERN) : null
    if (!match || match[1] !== migration.version) {
      fail(`${label}.path must be a matching repo-relative modern migration path`)
    }
    if (seenPaths.has(migration.path)) fail(`duplicate forward migration path: ${migration.path}`)
    assertSha256(migration.sha256, `${label}.sha256`)
    const record = readPinnedRegularFile(repoRoot, migration.path, label, { testHooks })
    const contents = record.contents
    validateNoSecrets(contents.toString('utf8'), migration.path)
    if (record.sha256 !== migration.sha256) {
      fail(`${label}.sha256 does not match ${migration.path}`)
    }
    validateReplaySqlSafety(contents.toString('utf8'), { label: migration.path })
    previousVersion = migration.version
    seenPaths.add(migration.path)
    replayMigrations.push({ ...migration, absolutePath: record.path, record })
  }

  const migrationsRoot = path.join(repoRoot, 'supabase', 'migrations')
  assertPathComponentsAreTrusted(repoRoot, migrationsRoot, 'migration directory')
  const migrationDirectory = readTrustedDirectory(migrationsRoot, 'migration directory')
  const repositoryModernMigrations = []
  const repositoryFiles = new Map()
  const seenRepositoryVersions = new Set()
  for (const entry of readdirSync(migrationsRoot, { withFileTypes: true })) {
    const match = entry.name.match(/^(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/u)
    if (!match) continue
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail(`modern migration must be a regular non-symlink file: ${entry.name}`)
    }
    if (seenRepositoryVersions.has(match[1])) {
      fail(`modern migration version is duplicated in the repository: ${match[1]}`)
    }
    const repoPath = `supabase/migrations/${entry.name}`
    const record = readPinnedRegularFile(repoRoot, repoPath, repoPath, { testHooks })
    repositoryModernMigrations.push({
      path: repoPath,
      sha256: record.sha256,
      version: match[1],
    })
    repositoryFiles.set(repoPath, record)
    seenRepositoryVersions.add(match[1])
  }
  repositoryModernMigrations.sort((left, right) => left.version.localeCompare(right.version))
  if (canonicalJsonSha256(repositoryModernMigrations) !== document.repositoryMigrationSetSha256) {
    fail(
      'forward-migrations.json repositoryMigrationSetSha256 does not match the complete modern migration inventory'
    )
  }
  if (!seenRepositoryVersions.has(document.baselineThrough)) {
    fail('forward-migrations.json baselineThrough must name an existing modern migration file')
  }
  const expected = repositoryModernMigrations.filter(
    (migration) => migration.version > document.baselineThrough
  )
  expected.sort((left, right) => left.version.localeCompare(right.version))
  if (JSON.stringify(document.migrations) !== JSON.stringify(expected)) {
    fail('forward-migrations.json must list every modern migration newer than baselineThrough')
  }

  for (const migration of replayMigrations) {
    const inventoryRecord = repositoryFiles.get(migration.path)
    if (!inventoryRecord || inventoryRecord.sha256 !== migration.sha256) {
      fail(`${migration.path} changed between forward-manifest and repository inventory reads`)
    }
    migration.record = inventoryRecord
    migration.absolutePath = inventoryRecord.path
  }

  return {
    baselineThrough: document.baselineThrough,
    migrationDirectory,
    migrationCount: document.migrations.length,
    migrationNames: repositoryModernMigrations.map((migration) => path.basename(migration.path)),
    migrations: replayMigrations,
    repositoryFiles,
  }
}

function validateSourceCatalog(document, manifestSource) {
  assertExactKeys(
    document,
    ['capturedAt', 'catalog', 'contract', 'ledger', 'postgresMajor'],
    'source-catalog.json'
  )
  if (document.contract !== SOURCE_CATALOG_CONTRACT) {
    fail(`source-catalog.json contract must be ${SOURCE_CATALOG_CONTRACT}`)
  }
  if (document.postgresMajor !== 17) fail('source-catalog.json postgresMajor must be 17')
  assertIsoTimestamp(document.capturedAt, 'source-catalog.json capturedAt')
  if (document.capturedAt !== manifestSource.capturedAt) {
    fail('source-catalog.json capturedAt must match manifest source capturedAt')
  }
  assertExactKeys(document.catalog, SOURCE_CATALOG_KEYS, 'source-catalog.json catalog')
  validateSourceCatalogRowContracts(document.catalog, { fail })
  for (const key of SOURCE_CATALOG_KEYS) {
    assertCanonicalObjectArray(document.catalog[key], `source-catalog.json catalog ${key}`)
  }
  assertCanonicalObjectArray(document.ledger, 'source-catalog.json ledger')
  validateSourceLedgerRowContracts(document.ledger, { fail })
  const modernVersions = []
  const seenModernVersions = new Set()
  for (const [index, entry] of document.ledger.entries()) {
    const label = `source-catalog.json ledger[${index}]`
    if (VERSION_PATTERN.test(entry.version)) {
      if (seenModernVersions.has(entry.version)) {
        fail(`${label}.version duplicates modern source ledger version ${entry.version}`)
      }
      seenModernVersions.add(entry.version)
      modernVersions.push(entry.version)
    }
  }
  if (canonicalJsonSha256(document.catalog) !== manifestSource.catalogSha256) {
    fail('source-catalog.json catalog digest does not match manifest source catalogSha256')
  }
  if (canonicalJsonSha256(document.ledger) !== manifestSource.ledgerSha256) {
    fail('source-catalog.json ledger digest does not match manifest source ledgerSha256')
  }
  modernVersions.sort()
  return { modernVersions }
}

function validatePlatformPrerequisites(document) {
  assertExactKeys(
    document,
    [
      'contract',
      'extensions',
      'functions',
      'postgresMajor',
      'relations',
      'roles',
      'schemas',
      'types',
    ],
    'platform-prerequisites.json'
  )
  if (document.contract !== PLATFORM_PREREQUISITES_CONTRACT) {
    fail(`platform-prerequisites.json contract must be ${PLATFORM_PREREQUISITES_CONTRACT}`)
  }
  if (document.postgresMajor !== 17) {
    fail('platform-prerequisites.json postgresMajor must be 17')
  }
  for (const key of ['extensions', 'functions', 'relations', 'roles', 'schemas', 'types']) {
    assertSortedUniqueStrings(document[key], `platform-prerequisites.json ${key}`)
  }
}

function validateFoundation(document, repoRoot, { testHooks } = {}) {
  assertExactKeys(
    document,
    ['contract', 'path', 'postgresMajor', 'sha256', 'status'],
    'manifest.json foundation'
  )
  if (document.contract !== FOUNDATION_CONTRACT) {
    fail(`manifest.json foundation contract must be ${FOUNDATION_CONTRACT}`)
  }
  if (document.status !== FOUNDATION_STATUS) {
    fail(`manifest.json foundation status must remain ${FOUNDATION_STATUS}`)
  }
  if (document.postgresMajor !== 17) {
    fail('manifest.json foundation postgresMajor must be 17')
  }
  if (typeof document.path !== 'string' || !FOUNDATION_PATH_PATTERN.test(document.path)) {
    fail('manifest.json foundation path must name a repository baseline-foundations SQL file')
  }
  assertSha256(document.sha256, 'manifest.json foundation sha256')
  const record = readPinnedRegularFile(repoRoot, document.path, 'manifest.json foundation path', {
    testHooks,
  })
  const contents = record.contents
  validateNoSecrets(contents.toString('utf8'), document.path)
  validateFoundationSqlSafety(contents.toString('utf8'), { label: document.path })
  if (record.sha256 !== document.sha256) {
    fail('manifest.json foundation sha256 does not match its SQL file')
  }
  return { absolutePath: record.path, path: document.path, record, sha256: document.sha256 }
}

function snapshotDirectoryHierarchy(
  repoRoot,
  candidatesRoot,
  candidateDir,
  { includeCandidate = true } = {}
) {
  const records = []
  records.push(readTrustedDirectory(repoRoot, 'repository root'))
  let current = repoRoot
  for (const segment of assertInside(
    repoRoot,
    candidatesRoot,
    'baseline candidates directory'
  ).split(path.sep)) {
    current = path.join(current, segment)
    records.push(readTrustedDirectory(current, 'baseline candidates directory hierarchy'))
  }
  if (includeCandidate) {
    records.push(
      readTrustedDirectory(candidateDir, 'candidate directory', {
        privateDirectory: true,
      })
    )
  }
  return Object.freeze(records)
}

function assertDirectoryHierarchyUnchanged(records) {
  for (const record of records) assertDirectoryRecordUnchanged(record)
}

function readCandidateEntries(candidateDir, expectedEntries) {
  const entries = readdirSync(candidateDir, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  if (
    names.length !== expectedEntries.length ||
    names.some((entry, index) => entry !== expectedEntries[index])
  ) {
    fail(`candidate directory must contain exactly: ${expectedEntries.join(', ')}`)
  }
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    fail('every candidate artifact must be a regular non-symlink file')
  }
  return names
}

function readModernMigrationNames(migrationsRoot) {
  const names = []
  for (const entry of readdirSync(migrationsRoot, { withFileTypes: true })) {
    if (!/^(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/u.test(entry.name)) continue
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail(`modern migration must be a regular non-symlink file: ${entry.name}`)
    }
    names.push(entry.name)
  }
  return names.sort()
}

function assertExactStringArray(actual, expected, message) {
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    fail(message)
  }
}

function serializeIdentity(identity) {
  return Object.freeze({
    ctimeNs: identity.ctimeNs.toString(),
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    mode: permissionBits(identity).toString(8).padStart(4, '0'),
    mtimeNs: identity.mtimeNs.toString(),
    size: identity.size.toString(),
    uid: identity.uid.toString(),
  })
}

function replayFile(record, extra = {}) {
  return {
    absolutePath: record.path,
    contents: Buffer.from(record.contents),
    identity: serializeIdentity(record.identity),
    sha256: record.sha256,
    ...extra,
  }
}

function finalVerifyEvidence({
  artifactRecords,
  expectedCandidateEntries,
  forward,
  foundation,
  hierarchyRecords,
  physicalCandidate,
  testHooks,
}) {
  callHook(testHooks, 'beforeFinalVerification', { candidateDir: physicalCandidate })
  assertDirectoryHierarchyUnchanged(hierarchyRecords)
  readCandidateEntries(physicalCandidate, expectedCandidateEntries)

  const finalArtifacts = new Map()
  for (const [name, record] of artifactRecords) {
    finalArtifacts.set(name, reopenPinnedFile(record, testHooks))
  }
  const finalFoundation = reopenPinnedFile(foundation.record, testHooks)

  assertDirectoryRecordUnchanged(forward.migrationDirectory)
  assertExactStringArray(
    readModernMigrationNames(forward.migrationDirectory.path),
    [...forward.migrationNames].sort(),
    'modern migration inventory changed during candidate validation'
  )
  const finalRepositoryFiles = new Map()
  for (const [migrationPath, record] of forward.repositoryFiles) {
    finalRepositoryFiles.set(migrationPath, reopenPinnedFile(record, testHooks))
  }

  // A last path-identity sweep ensures an early final-pass file was not swapped
  // while later evidence was being re-opened and re-hashed.
  for (const record of finalArtifacts.values()) assertPinnedPathUnchanged(record)
  assertPinnedPathUnchanged(finalFoundation)
  for (const record of finalRepositoryFiles.values()) assertPinnedPathUnchanged(record)
  assertDirectoryHierarchyUnchanged(hierarchyRecords)
  assertDirectoryRecordUnchanged(forward.migrationDirectory)
  readCandidateEntries(physicalCandidate, expectedCandidateEntries)
  assertExactStringArray(
    readModernMigrationNames(forward.migrationDirectory.path),
    [...forward.migrationNames].sort(),
    'modern migration inventory changed during candidate validation'
  )

  return { finalArtifacts, finalFoundation, finalRepositoryFiles }
}

export function validateBaselineCandidate({
  candidateDir,
  repoRoot = SCRIPT_ROOT,
  candidatesRoot = path.join(repoRoot, 'supabase', 'baseline-candidates'),
  includeReplayPlan = false,
  testHooks,
} = {}) {
  if (typeof candidateDir !== 'string' || candidateDir.length === 0) {
    fail('an explicit candidate directory is required')
  }
  const requestedRepoRoot = path.resolve(repoRoot)
  assertDirectoryRootIsNotSymlink(requestedRepoRoot, 'repository root')
  const physicalRepoRoot = realpathSync(requestedRepoRoot)
  const requestedCandidatesRoot = path.resolve(candidatesRoot)
  const requestedCandidate = path.resolve(candidateDir)
  assertPathComponentsAreTrusted(
    requestedRepoRoot,
    requestedCandidatesRoot,
    'baseline candidates directory'
  )
  assertDirectoryRootIsNotSymlink(requestedCandidatesRoot, 'baseline candidates directory')
  const physicalCandidatesRoot = realpathSync(requestedCandidatesRoot)
  assertInside(physicalRepoRoot, physicalCandidatesRoot, 'baseline candidates directory')
  assertPathComponentsAreTrusted(requestedCandidatesRoot, requestedCandidate, 'candidate directory')
  const candidateStat = lstatSync(requestedCandidate, { bigint: true })
  assertTrustedDirectoryStat(candidateStat, 'candidate directory', { privateDirectory: true })
  const physicalCandidate = realpathSync(requestedCandidate)
  const candidateRelative = assertInside(
    physicalCandidatesRoot,
    physicalCandidate,
    'candidate directory'
  )
  if (candidateRelative.includes(path.sep) || !CANDIDATE_NAME_PATTERN.test(candidateRelative)) {
    fail('candidate directory must be one direct, safely named child of baseline-candidates')
  }
  const expectedEntries = ['manifest.json', ...REQUIRED_ARTIFACTS].sort()
  const hierarchyRecords = snapshotDirectoryHierarchy(
    physicalRepoRoot,
    physicalCandidatesRoot,
    physicalCandidate
  )
  readCandidateEntries(physicalCandidate, expectedEntries)

  const artifactRecords = new Map()
  const artifactContents = new Map()
  for (const fileName of ['manifest.json', ...REQUIRED_ARTIFACTS]) {
    const record = readPinnedRegularFile(physicalCandidate, fileName, fileName, {
      privateFile: true,
      testHooks,
    })
    artifactRecords.set(fileName, record)
    artifactContents.set(fileName, record.contents)
    validateNoSecrets(record.contents.toString('utf8'), fileName)
  }

  const manifest = parseJson(
    artifactContents.get('manifest.json').toString('utf8'),
    'manifest.json'
  )
  assertExactKeys(
    manifest,
    ['contract', 'files', 'foundation', 'postgresMajor', 'source', 'status'],
    'manifest.json'
  )
  if (manifest.contract !== BASELINE_CANDIDATE_CONTRACT) {
    fail(`manifest.json contract must be ${BASELINE_CANDIDATE_CONTRACT}`)
  }
  if (manifest.status !== CANDIDATE_STATUS) {
    fail(`manifest.json status must remain ${CANDIDATE_STATUS}`)
  }
  if (manifest.postgresMajor !== 17) fail('manifest.json postgresMajor must be 17')
  assertExactKeys(
    manifest.source,
    ['capturedAt', 'catalogSha256', 'gitSha', 'ledgerSha256', 'projectRefSha256', 'transport'],
    'manifest.json source'
  )
  assertIsoTimestamp(manifest.source.capturedAt, 'manifest.json source capturedAt')
  if (typeof manifest.source.gitSha !== 'string' || !GIT_SHA_PATTERN.test(manifest.source.gitSha)) {
    fail('manifest.json source gitSha must be a full lowercase Git SHA')
  }
  for (const key of ['catalogSha256', 'ledgerSha256', 'projectRefSha256']) {
    assertSha256(manifest.source[key], `manifest.json source ${key}`)
  }
  if (manifest.source.transport !== 'session-or-direct/verify-full/read-only') {
    fail('manifest.json source transport must be session-or-direct/verify-full/read-only')
  }
  assertExactKeys(manifest.files, REQUIRED_ARTIFACTS, 'manifest.json files')
  for (const fileName of REQUIRED_ARTIFACTS) {
    assertSha256(manifest.files[fileName], `manifest.json files ${fileName}`)
    const actual = sha256(artifactContents.get(fileName))
    if (actual !== manifest.files[fileName]) {
      fail(`manifest.json digest does not match ${fileName}`)
    }
  }

  const foundation = validateFoundation(manifest.foundation, physicalRepoRoot, { testHooks })

  const appSchemaSafety = validateAppSchemaSqlSafety(
    artifactContents.get('app-schema.sql').toString('utf8'),
    {
      label: 'app-schema.sql',
    }
  )
  if (appSchemaSafety.restrictionToken === null) {
    fail('app-schema.sql must retain its PostgreSQL 17.6+ restrict/unrestrict envelope')
  }
  const sourceDocument = parseJson(
    artifactContents.get('source-catalog.json').toString('utf8'),
    'source-catalog.json'
  )
  const sourceLedger = validateSourceCatalog(sourceDocument, manifest.source)
  const forwardDocument = parseJson(
    artifactContents.get('forward-migrations.json').toString('utf8'),
    'forward-migrations.json'
  )
  const forward = validateForwardManifest(forwardDocument, physicalRepoRoot, sourceLedger, {
    testHooks,
  })
  const prerequisiteDocument = parseJson(
    artifactContents.get('platform-prerequisites.json').toString('utf8'),
    'platform-prerequisites.json'
  )
  validatePlatformPrerequisites(prerequisiteDocument)

  const { finalArtifacts, finalFoundation, finalRepositoryFiles } = finalVerifyEvidence({
    artifactRecords,
    expectedCandidateEntries: expectedEntries,
    forward,
    foundation,
    hierarchyRecords,
    physicalCandidate,
    testHooks,
  })

  const result = {
    candidate: path.relative(physicalRepoRoot, physicalCandidate).split(path.sep).join('/'),
    baselineThrough: forward.baselineThrough,
    migrationCount: forward.migrationCount,
    postgresMajor: 17,
    status: CANDIDATE_STATUS,
  }
  if (includeReplayPlan) {
    result.replayPlan = {
      appSchema: replayFile(finalArtifacts.get('app-schema.sql')),
      forwardManifest: replayFile(finalArtifacts.get('forward-migrations.json')),
      foundation: replayFile(finalFoundation, { path: foundation.path }),
      forwardMigrations: forward.migrations.map((migration) => {
        const record = finalRepositoryFiles.get(migration.path)
        if (!record) fail(`${migration.path} is missing from the final migration inventory`)
        return replayFile(record, { path: migration.path, version: migration.version })
      }),
      platformPrerequisites: prerequisiteDocument,
      platformPrerequisitesFile: replayFile(finalArtifacts.get('platform-prerequisites.json')),
      sourceCatalog: replayFile(finalArtifacts.get('source-catalog.json'), {
        baselineThrough: forward.baselineThrough,
        catalogSha256: manifest.source.catalogSha256,
        ledgerSha256: manifest.source.ledgerSha256,
      }),
    }
  }
  return result
}

export function validateAllBaselineCandidates({
  repoRoot = SCRIPT_ROOT,
  candidatesRoot = path.join(repoRoot, 'supabase', 'baseline-candidates'),
} = {}) {
  const requestedRepoRoot = path.resolve(repoRoot)
  assertDirectoryRootIsNotSymlink(requestedRepoRoot, 'repository root')
  const physicalRepoRoot = realpathSync(requestedRepoRoot)
  const requestedCandidatesRoot = path.resolve(candidatesRoot)
  assertPathComponentsAreTrusted(
    requestedRepoRoot,
    requestedCandidatesRoot,
    'baseline candidates directory'
  )
  assertDirectoryRootIsNotSymlink(requestedCandidatesRoot, 'baseline candidates directory')
  const physicalCandidatesRoot = realpathSync(requestedCandidatesRoot)
  assertInside(physicalRepoRoot, physicalCandidatesRoot, 'baseline candidates directory')
  const hierarchyRecords = snapshotDirectoryHierarchy(
    physicalRepoRoot,
    physicalCandidatesRoot,
    physicalCandidatesRoot,
    { includeCandidate: false }
  )
  const entries = readdirSync(physicalCandidatesRoot, { withFileTypes: true })
  const inventory = entries
    .map((entry) => ({
      directory: entry.isDirectory(),
      file: entry.isFile(),
      name: entry.name,
      symlink: entry.isSymbolicLink(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const candidates = []
  for (const entry of entries) {
    if (entry.name === 'README.md' && entry.isFile() && !entry.isSymbolicLink()) continue
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !CANDIDATE_NAME_PATTERN.test(entry.name)
    ) {
      fail(`unexpected baseline-candidates entry: ${entry.name}`)
    }
    candidates.push(
      validateBaselineCandidate({
        candidateDir: path.join(physicalCandidatesRoot, entry.name),
        candidatesRoot: physicalCandidatesRoot,
        repoRoot: physicalRepoRoot,
      })
    )
  }
  assertDirectoryHierarchyUnchanged(hierarchyRecords)
  const finalInventory = readdirSync(physicalCandidatesRoot, { withFileTypes: true })
    .map((entry) => ({
      directory: entry.isDirectory(),
      file: entry.isFile(),
      name: entry.name,
      symlink: entry.isSymbolicLink(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (JSON.stringify(inventory) !== JSON.stringify(finalInventory)) {
    fail('baseline candidate inventory changed during validation')
  }
  candidates.sort((left, right) => left.candidate.localeCompare(right.candidate))
  return { candidateCount: candidates.length, candidates }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] === '--help') {
    const stream = argv[0] === '--help' ? process.stdout : process.stderr
    stream.write(
      'Usage: node scripts/qa/validate-baseline-candidate.mjs <supabase/baseline-candidates/name>|--all\n'
    )
    if (argv[0] !== '--help') process.exitCode = 2
    return
  }
  try {
    const result =
      argv[0] === '--all'
        ? validateAllBaselineCandidates({
            candidatesRoot: DEFAULT_CANDIDATES_ROOT,
            repoRoot: SCRIPT_ROOT,
          })
        : validateBaselineCandidate({
            candidateDir: path.resolve(argv[0]),
            candidatesRoot: DEFAULT_CANDIDATES_ROOT,
            repoRoot: SCRIPT_ROOT,
          })
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`Baseline candidate validation failed: ${error.message}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
