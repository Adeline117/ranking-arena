#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  validateAppSchemaSqlSafety,
  validateFoundationSqlSafety,
  validateReplaySqlSafety,
} from './baseline-sql-safety.mjs'

export const BASELINE_CANDIDATE_CONTRACT = 'arena.canonical-baseline-candidate@1'
export const FORWARD_MIGRATIONS_CONTRACT = 'arena.canonical-baseline-forward-migrations@1'
export const SOURCE_CATALOG_CONTRACT = 'arena.canonical-baseline-source-catalog@1'
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
const SOURCE_CATALOG_KEYS = Object.freeze([
  'acls',
  'columns',
  'constraints',
  'defaultPrivileges',
  'extensions',
  'functions',
  'indexes',
  'policies',
  'publications',
  'schemas',
  'tables',
  'triggers',
  'types',
  'views',
])

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

function assertPathComponentsAreNotSymlinks(root, target, label) {
  const relative = assertInside(root, target, label)
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      fail(`${label} does not exist: ${current}`)
    }
    if (stat.isSymbolicLink()) fail(`${label} must not contain a symlink: ${current}`)
  }
}

function assertDirectoryRootIsNotSymlink(root, label) {
  let stat
  try {
    stat = lstatSync(root)
  } catch {
    fail(`${label} does not exist: ${root}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a real directory, not a symlink`)
  }
}

function resolveRegularFile(root, relativePath, label) {
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
  const rootPrefix = `${root}${path.sep}`
  if (!target.startsWith(rootPrefix)) fail(`${label} escapes its allowed root`)
  assertPathComponentsAreNotSymlinks(root, target, label)
  const stat = lstatSync(target)
  if (!stat.isFile()) fail(`${label} must be a regular file`)
  const physical = realpathSync(target)
  if (!physical.startsWith(rootPrefix)) fail(`${label} resolves outside its allowed root`)
  return physical
}

function validateNoSecrets(contents, label) {
  const patterns = [
    /\bpostgres(?:ql)?:\/\/[^\s'"<>]+/iu,
    /\bhttps?:\/\/[a-z0-9-]+\.supabase\.co\b/iu,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{12,}\b/u,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /https:\/\/hooks\.slack\.com\/services\//iu,
    /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/u,
  ]
  if (patterns.some((pattern) => pattern.test(contents))) {
    fail(`${label} contains a credential or connection identifier`)
  }
}

function validateForwardManifest(document, repoRoot, sourceLedger) {
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
    const migrationPath = resolveRegularFile(repoRoot, migration.path, label)
    const contents = readFileSync(migrationPath)
    validateNoSecrets(contents.toString('utf8'), migration.path)
    const actual = sha256(contents)
    if (actual !== migration.sha256) {
      fail(`${label}.sha256 does not match ${migration.path}`)
    }
    validateReplaySqlSafety(contents.toString('utf8'), { label: migration.path })
    previousVersion = migration.version
    seenPaths.add(migration.path)
    replayMigrations.push({ ...migration, absolutePath: migrationPath })
  }

  const migrationsRoot = path.join(repoRoot, 'supabase', 'migrations')
  assertPathComponentsAreNotSymlinks(repoRoot, migrationsRoot, 'migration directory')
  const repositoryModernMigrations = []
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
    const absolutePath = resolveRegularFile(repoRoot, repoPath, repoPath)
    repositoryModernMigrations.push({
      path: repoPath,
      sha256: sha256(readFileSync(absolutePath)),
      version: match[1],
    })
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

  return {
    baselineThrough: document.baselineThrough,
    migrationCount: document.migrations.length,
    migrations: replayMigrations,
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
  for (const key of SOURCE_CATALOG_KEYS) {
    assertCanonicalObjectArray(document.catalog[key], `source-catalog.json catalog ${key}`)
  }
  assertCanonicalObjectArray(document.ledger, 'source-catalog.json ledger')
  const modernVersions = []
  const seenModernVersions = new Set()
  for (const [index, entry] of document.ledger.entries()) {
    const label = `source-catalog.json ledger[${index}]`
    assertExactKeys(entry, ['name', 'statementsSha256', 'version'], label)
    if (
      typeof entry.version !== 'string' ||
      entry.version.length === 0 ||
      entry.version.trim() !== entry.version ||
      /[\u0000-\u001f\u007f]/u.test(entry.version)
    ) {
      fail(`${label}.version must be a non-empty printable string`)
    }
    if (
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      entry.name.trim() !== entry.name ||
      /[\u0000-\u001f\u007f]/u.test(entry.name)
    ) {
      fail(`${label}.name must be a non-empty printable string`)
    }
    assertSha256(entry.statementsSha256, `${label}.statementsSha256`)
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

function validateFoundation(document, repoRoot) {
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
  const foundationPath = resolveRegularFile(
    repoRoot,
    document.path,
    'manifest.json foundation path'
  )
  const contents = readFileSync(foundationPath)
  validateNoSecrets(contents.toString('utf8'), document.path)
  validateFoundationSqlSafety(contents.toString('utf8'), { label: document.path })
  if (sha256(contents) !== document.sha256) {
    fail('manifest.json foundation sha256 does not match its SQL file')
  }
  return { absolutePath: foundationPath, path: document.path, sha256: document.sha256 }
}

export function validateBaselineCandidate({
  candidateDir,
  repoRoot = SCRIPT_ROOT,
  candidatesRoot = path.join(repoRoot, 'supabase', 'baseline-candidates'),
  includeReplayPlan = false,
} = {}) {
  if (typeof candidateDir !== 'string' || candidateDir.length === 0) {
    fail('an explicit candidate directory is required')
  }
  const requestedRepoRoot = path.resolve(repoRoot)
  assertDirectoryRootIsNotSymlink(requestedRepoRoot, 'repository root')
  const physicalRepoRoot = realpathSync(requestedRepoRoot)
  const requestedCandidatesRoot = path.resolve(candidatesRoot)
  const requestedCandidate = path.resolve(candidateDir)
  assertPathComponentsAreNotSymlinks(
    requestedRepoRoot,
    requestedCandidatesRoot,
    'baseline candidates directory'
  )
  const physicalCandidatesRoot = realpathSync(requestedCandidatesRoot)
  assertInside(physicalRepoRoot, physicalCandidatesRoot, 'baseline candidates directory')
  assertPathComponentsAreNotSymlinks(
    requestedCandidatesRoot,
    requestedCandidate,
    'candidate directory'
  )
  const candidateStat = lstatSync(requestedCandidate)
  if (!candidateStat.isDirectory()) fail('candidate directory must be a directory')
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
  const actualEntries = readdirSync(physicalCandidate, { withFileTypes: true })
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries
      .map((entry) => entry.name)
      .sort()
      .some((entry, index) => entry !== expectedEntries[index])
  ) {
    fail(`candidate directory must contain exactly: ${expectedEntries.join(', ')}`)
  }
  if (actualEntries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    fail('every candidate artifact must be a regular non-symlink file')
  }

  const artifactContents = new Map()
  for (const fileName of ['manifest.json', ...REQUIRED_ARTIFACTS]) {
    const filePath = resolveRegularFile(physicalCandidate, fileName, fileName)
    const contents = readFileSync(filePath)
    artifactContents.set(fileName, contents)
    validateNoSecrets(contents.toString('utf8'), fileName)
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

  const foundation = validateFoundation(manifest.foundation, physicalRepoRoot)

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
  const forward = validateForwardManifest(forwardDocument, physicalRepoRoot, sourceLedger)
  const prerequisiteDocument = parseJson(
    artifactContents.get('platform-prerequisites.json').toString('utf8'),
    'platform-prerequisites.json'
  )
  validatePlatformPrerequisites(prerequisiteDocument)

  const result = {
    candidate: path.relative(physicalRepoRoot, physicalCandidate).split(path.sep).join('/'),
    baselineThrough: forward.baselineThrough,
    migrationCount: forward.migrationCount,
    postgresMajor: 17,
    status: CANDIDATE_STATUS,
  }
  if (includeReplayPlan) {
    result.replayPlan = {
      appSchema: {
        absolutePath: path.join(physicalCandidate, 'app-schema.sql'),
        sha256: manifest.files['app-schema.sql'],
      },
      foundation,
      forwardMigrations: forward.migrations,
      platformPrerequisites: prerequisiteDocument,
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
  assertPathComponentsAreNotSymlinks(
    requestedRepoRoot,
    requestedCandidatesRoot,
    'baseline candidates directory'
  )
  const entries = readdirSync(requestedCandidatesRoot, { withFileTypes: true })
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
        candidateDir: path.join(requestedCandidatesRoot, entry.name),
        candidatesRoot: requestedCandidatesRoot,
        repoRoot: physicalRepoRoot,
      })
    )
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
