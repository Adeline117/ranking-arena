#!/usr/bin/env node

/**
 * Assemble one offline canonical-baseline candidate from an already completed
 * source capture and explicit reviewed repository inputs.
 *
 * This command has no database, network, environment-secret, or deployment
 * integration. It always emits candidate/not-deployable evidence and invokes
 * the canonical candidate validator before publishing anything.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BASELINE_CANDIDATE_CONTRACT,
  CANDIDATE_STATUS,
  FOUNDATION_CONTRACT,
  FOUNDATION_STATUS,
  FORWARD_MIGRATIONS_CONTRACT,
  canonicalJsonSha256,
  validateBaselineCandidate,
} from '../qa/validate-baseline-candidate.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CAPTURE_ARTIFACTS = Object.freeze(['app-schema.sql', 'source-catalog.json'])
const CANDIDATE_ARTIFACTS = Object.freeze([
  'app-schema.sql',
  'forward-migrations.json',
  'manifest.json',
  'platform-prerequisites.json',
  'source-catalog.json',
])
const MANIFEST_HASHED_ARTIFACTS = Object.freeze(
  CANDIDATE_ARTIFACTS.filter((name) => name !== 'manifest.json')
)
const INCOMPLETE_MARKER = '.arena-baseline-candidate-incomplete'
const CANDIDATE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u
const FOUNDATION_PATH_PATTERN = /^supabase\/baseline-foundations\/[a-z0-9][a-z0-9_-]*\.sql$/u
const MIGRATION_PATH_PATTERN = /^supabase\/migrations\/(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/u
const VERSION_PATTERN = /^\d{14}$/u
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function fail(code, cause) {
  throw new Error(code, cause ? { cause } : undefined)
}

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

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalizeJson(value), null, 2)}\n`)
}

function parseJson(contents, code) {
  try {
    return JSON.parse(contents.toString('utf8'))
  } catch {
    fail(code)
  }
}

function pathExists(target) {
  try {
    lstatSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function identity(stat) {
  return Object.freeze({
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    uid: stat.uid,
  })
}

function effectiveOwnerUid(code) {
  if (typeof process.geteuid !== 'function') fail(code)
  return process.geteuid()
}

function directoryIdentity(target, code) {
  let stat
  try {
    stat = lstatSync(target)
  } catch (error) {
    fail(code, error)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(code)
  return identity(stat)
}

function assertDirectoryIdentity(target, expected, code) {
  const actual = directoryIdentity(target, code)
  // Entry creation/removal legitimately changes directory size and timestamps.
  // The device/inode pair is the stable identity needed to reject swaps.
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail(code)
}

function assertOwnerControlledDirectory(target, code, { privateDirectory = false } = {}) {
  const metadata = lstatSync(target)
  const effectiveUserId = effectiveOwnerUid(code)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== effectiveUserId ||
    (metadata.mode & (privateDirectory ? 0o077 : 0o022)) !== 0
  ) {
    fail(code)
  }
}

function assertOwnerControlledHierarchy({
  candidatesIdentity,
  candidatesParent,
  candidatesParentIdentity,
  physicalCandidatesRoot,
  physicalRepoRoot,
  repoIdentity,
}) {
  assertDirectoryIdentity(physicalRepoRoot, repoIdentity, 'REPOSITORY_CHANGED_DURING_ASSEMBLY')
  assertOwnerControlledDirectory(
    physicalRepoRoot,
    'REPOSITORY_NOT_OWNER_CONTROLLED_DURING_ASSEMBLY'
  )
  assertDirectoryIdentity(
    candidatesParent,
    candidatesParentIdentity,
    'BASELINE_CANDIDATES_PARENT_CHANGED_DURING_ASSEMBLY'
  )
  assertOwnerControlledDirectory(
    candidatesParent,
    'BASELINE_CANDIDATES_PARENT_NOT_OWNER_CONTROLLED'
  )
  assertDirectoryIdentity(
    physicalCandidatesRoot,
    candidatesIdentity,
    'BASELINE_CANDIDATES_ROOT_CHANGED_DURING_ASSEMBLY'
  )
  assertOwnerControlledDirectory(
    physicalCandidatesRoot,
    'BASELINE_CANDIDATES_ROOT_NOT_OWNER_CONTROLLED'
  )
}

function assertInside(root, target, code) {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(code)
  return relative
}

function assertNoSymlinkComponents(root, target, code) {
  const relative = assertInside(root, target, code)
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      fail(code, error)
    }
    if (stat.isSymbolicLink()) fail(code)
  }
}

function readPinnedFile(target, code) {
  let descriptor
  try {
    if (typeof fsConstants.O_NOFOLLOW !== 'number') fail(code)
    const pathStat = lstatSync(target)
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) fail(code)
    descriptor = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino) fail(code)
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    if (!sameIdentity(identity(before), identity(after))) fail(code)
    return Object.freeze({
      contents,
      identity: identity(after),
      path: target,
      sha256: sha256(contents),
    })
  } catch (error) {
    if (error?.message === code) throw error
    fail(code, error)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function assertPinnedFileUnchanged(record, code) {
  const current = readPinnedFile(record.path, code)
  if (!sameIdentity(current.identity, record.identity) || current.sha256 !== record.sha256)
    fail(code)
}

function resolveAbsoluteInputFile(inputPath, code) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) fail(code)
  const requested = path.resolve(inputPath)
  if (requested !== inputPath) fail(code)
  let physical
  try {
    physical = realpathSync(requested)
  } catch (error) {
    fail(code, error)
  }
  if (physical !== requested) fail(code)
  return readPinnedFile(physical, code)
}

function resolveRepoFile(repoRoot, repoPath, pattern, code) {
  if (typeof repoPath !== 'string' || !pattern.test(repoPath)) fail(code)
  const target = path.resolve(repoRoot, repoPath)
  assertNoSymlinkComponents(repoRoot, target, code)
  if (realpathSync(target) !== target) fail(code)
  return readPinnedFile(target, code)
}

function readSourceCapture(sourceCaptureDir) {
  if (typeof sourceCaptureDir !== 'string' || !path.isAbsolute(sourceCaptureDir)) {
    fail('SOURCE_CAPTURE_PATH_INVALID')
  }
  const requested = path.resolve(sourceCaptureDir)
  if (requested !== sourceCaptureDir) fail('SOURCE_CAPTURE_PATH_INVALID')
  let physical
  try {
    physical = realpathSync(requested)
  } catch (error) {
    fail('SOURCE_CAPTURE_PATH_INVALID', error)
  }
  if (physical !== requested) fail('SOURCE_CAPTURE_PATH_INVALID')
  const directory = directoryIdentity(physical, 'SOURCE_CAPTURE_PATH_INVALID')
  const directoryStat = lstatSync(physical)
  const effectiveUserId = effectiveOwnerUid('SOURCE_CAPTURE_DIRECTORY_NOT_PRIVATE')
  if ((directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== effectiveUserId) {
    fail('SOURCE_CAPTURE_DIRECTORY_NOT_PRIVATE')
  }
  const entries = readdirSync(physical, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )
  if (
    entries.length !== CAPTURE_ARTIFACTS.length ||
    entries.some(
      (entry, index) =>
        entry.name !== [...CAPTURE_ARTIFACTS].sort()[index] ||
        entry.isSymbolicLink() ||
        !entry.isFile()
    )
  ) {
    fail('SOURCE_CAPTURE_ARTIFACT_SET_INVALID')
  }
  const files = new Map()
  for (const name of CAPTURE_ARTIFACTS) {
    const record = readPinnedFile(path.join(physical, name), 'SOURCE_CAPTURE_ARTIFACT_INVALID')
    const fileStat = lstatSync(record.path)
    if ((fileStat.mode & 0o077) !== 0 || fileStat.uid !== effectiveUserId) {
      fail('SOURCE_CAPTURE_ARTIFACT_NOT_PRIVATE')
    }
    files.set(name, record)
  }
  return Object.freeze({ directory, files, path: physical })
}

function readModernMigrationInventory(repoRoot) {
  const migrationsRoot = path.join(repoRoot, 'supabase', 'migrations')
  assertNoSymlinkComponents(repoRoot, migrationsRoot, 'MIGRATION_DIRECTORY_INVALID')
  if (realpathSync(migrationsRoot) !== migrationsRoot) fail('MIGRATION_DIRECTORY_INVALID')
  const directory = directoryIdentity(migrationsRoot, 'MIGRATION_DIRECTORY_INVALID')
  const migrations = []
  const versions = new Set()
  for (const entry of readdirSync(migrationsRoot, { withFileTypes: true })) {
    const match = entry.name.match(/^(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/u)
    if (!match) continue
    if (entry.isSymbolicLink() || !entry.isFile()) fail('MIGRATION_FILE_INVALID')
    if (versions.has(match[1])) fail('MIGRATION_VERSION_DUPLICATED')
    const repoPath = `supabase/migrations/${entry.name}`
    const file = resolveRepoFile(
      repoRoot,
      repoPath,
      MIGRATION_PATH_PATTERN,
      'MIGRATION_FILE_INVALID'
    )
    migrations.push(
      Object.freeze({
        file,
        path: repoPath,
        sha256: file.sha256,
        version: match[1],
      })
    )
    versions.add(match[1])
  }
  migrations.sort((left, right) =>
    left.version < right.version ? -1 : left.version > right.version ? 1 : 0
  )
  return Object.freeze({ directory, migrations, path: migrationsRoot })
}

function validateExplicitValues({
  baselineThrough,
  candidateName,
  forwardMigrationPaths,
  projectRefSha256,
  sourceGitSha,
}) {
  if (typeof candidateName !== 'string' || !CANDIDATE_NAME_PATTERN.test(candidateName)) {
    fail('CANDIDATE_NAME_INVALID')
  }
  if (typeof baselineThrough !== 'string' || !VERSION_PATTERN.test(baselineThrough)) {
    fail('BASELINE_BOUNDARY_INVALID')
  }
  if (typeof sourceGitSha !== 'string' || !GIT_SHA_PATTERN.test(sourceGitSha)) {
    fail('SOURCE_GIT_SHA_INVALID')
  }
  if (typeof projectRefSha256 !== 'string' || !SHA256_PATTERN.test(projectRefSha256)) {
    fail('PROJECT_REF_SHA256_INVALID')
  }
  if (!Array.isArray(forwardMigrationPaths)) fail('FORWARD_MIGRATIONS_NOT_EXPLICIT')
  for (const migrationPath of forwardMigrationPaths) {
    if (typeof migrationPath !== 'string' || !MIGRATION_PATH_PATTERN.test(migrationPath)) {
      fail('FORWARD_MIGRATION_PATH_INVALID')
    }
  }
  if (new Set(forwardMigrationPaths).size !== forwardMigrationPaths.length) {
    fail('FORWARD_MIGRATION_PATH_DUPLICATED')
  }
}

function assertSourceBoundary(sourceDocument, baselineThrough) {
  if (!sourceDocument || Array.isArray(sourceDocument) || typeof sourceDocument !== 'object') {
    fail('SOURCE_CATALOG_INVALID')
  }
  if (!Array.isArray(sourceDocument.ledger)) fail('SOURCE_CATALOG_INVALID')
  const versions = sourceDocument.ledger
    .map((entry) => entry?.version)
    .filter((version) => typeof version === 'string' && VERSION_PATTERN.test(version))
    .sort()
  if (versions.length === 0 || new Set(versions).size !== versions.length) {
    fail('SOURCE_LEDGER_BOUNDARY_INVALID')
  }
  if (versions.at(-1) !== baselineThrough) fail('SOURCE_LEDGER_BOUNDARY_MISMATCH')
}

function assertForwardInputs(inventory, baselineThrough, forwardMigrationPaths) {
  const boundary = inventory.migrations.find((migration) => migration.version === baselineThrough)
  if (!boundary) fail('BASELINE_BOUNDARY_NOT_IN_REPOSITORY')
  const expected = inventory.migrations
    .filter((migration) => migration.version > baselineThrough)
    .map((migration) => migration.path)
  if (JSON.stringify(expected) !== JSON.stringify(forwardMigrationPaths)) {
    fail('FORWARD_MIGRATION_SET_INCOMPLETE_OR_UNORDERED')
  }
}

function writeExclusive(target, contents) {
  writeFileSync(target, contents, { flag: 'wx', mode: 0o600 })
}

function writeArtifacts(directory, artifacts) {
  mkdirSync(directory, { mode: 0o700 })
  for (const name of CANDIDATE_ARTIFACTS)
    writeExclusive(path.join(directory, name), artifacts.get(name))
}

function buildArtifacts({
  baselineThrough,
  foundationPath,
  foundationRecord,
  inventory,
  platformPrerequisites,
  projectRefSha256,
  sourceCapture,
  sourceDocument,
  sourceGitSha,
}) {
  const forwardMigrations = inventory.migrations
    .filter((migration) => migration.version > baselineThrough)
    .map(({ path: migrationPath, sha256: digest, version }) => ({
      path: migrationPath,
      sha256: digest,
      version,
    }))
  const repositoryMigrations = inventory.migrations.map(
    ({ path: migrationPath, sha256: digest, version }) => ({
      path: migrationPath,
      sha256: digest,
      version,
    })
  )
  const forwardDocument = {
    baselineThrough,
    contract: FORWARD_MIGRATIONS_CONTRACT,
    migrationSetSha256: canonicalJsonSha256(forwardMigrations),
    migrations: forwardMigrations,
    repositoryMigrationSetSha256: canonicalJsonSha256(repositoryMigrations),
  }
  const artifacts = new Map([
    ['app-schema.sql', sourceCapture.files.get('app-schema.sql').contents],
    ['forward-migrations.json', jsonBytes(forwardDocument)],
    ['platform-prerequisites.json', jsonBytes(platformPrerequisites)],
    ['source-catalog.json', sourceCapture.files.get('source-catalog.json').contents],
  ])
  const fileDigests = Object.fromEntries(
    MANIFEST_HASHED_ARTIFACTS.map((name) => [name, sha256(artifacts.get(name))])
  )
  const manifest = {
    contract: BASELINE_CANDIDATE_CONTRACT,
    files: fileDigests,
    foundation: {
      contract: FOUNDATION_CONTRACT,
      path: foundationPath,
      postgresMajor: 17,
      sha256: foundationRecord.sha256,
      status: FOUNDATION_STATUS,
    },
    postgresMajor: 17,
    source: {
      capturedAt: sourceDocument.capturedAt,
      catalogSha256: canonicalJsonSha256(sourceDocument.catalog),
      gitSha: sourceGitSha,
      ledgerSha256: canonicalJsonSha256(sourceDocument.ledger),
      projectRefSha256,
      transport: 'session-or-direct/verify-full/read-only',
    },
    status: CANDIDATE_STATUS,
  }
  artifacts.set('manifest.json', jsonBytes(manifest))
  return artifacts
}

function validatePrivateStage({
  artifacts,
  candidateName,
  foundationPath,
  foundationRecord,
  inventory,
  stageRoot,
}) {
  const validationRepo = path.join(stageRoot, 'validation-repo')
  const validationCandidateRoot = path.join(validationRepo, 'supabase', 'baseline-candidates')
  const validationCandidate = path.join(validationCandidateRoot, candidateName)
  mkdirSync(validationCandidateRoot, { recursive: true, mode: 0o700 })
  mkdirSync(path.join(validationRepo, 'supabase', 'migrations'), { recursive: true, mode: 0o700 })
  mkdirSync(path.dirname(path.join(validationRepo, foundationPath)), {
    recursive: true,
    mode: 0o700,
  })
  writeExclusive(path.join(validationRepo, foundationPath), foundationRecord.contents)
  for (const migration of inventory.migrations) {
    writeExclusive(path.join(validationRepo, migration.path), migration.file.contents)
  }
  writeArtifacts(validationCandidate, artifacts)
  return validateBaselineCandidate({
    candidateDir: validationCandidate,
    candidatesRoot: validationCandidateRoot,
    repoRoot: validationRepo,
  })
}

function assertCaptureUnchanged(sourceCapture) {
  assertDirectoryIdentity(
    sourceCapture.path,
    sourceCapture.directory,
    'SOURCE_CAPTURE_CHANGED_DURING_ASSEMBLY'
  )
  const directoryStat = lstatSync(sourceCapture.path)
  const effectiveUserId = effectiveOwnerUid('SOURCE_CAPTURE_CHANGED_DURING_ASSEMBLY')
  if ((directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== effectiveUserId) {
    fail('SOURCE_CAPTURE_CHANGED_DURING_ASSEMBLY')
  }
  const entries = readdirSync(sourceCapture.path).sort()
  if (JSON.stringify(entries) !== JSON.stringify([...CAPTURE_ARTIFACTS].sort())) {
    fail('SOURCE_CAPTURE_CHANGED_DURING_ASSEMBLY')
  }
  for (const record of sourceCapture.files.values()) {
    assertPinnedFileUnchanged(record, 'SOURCE_CAPTURE_CHANGED_DURING_ASSEMBLY')
  }
}

function assertInventoryUnchanged(inventory) {
  assertDirectoryIdentity(
    inventory.path,
    inventory.directory,
    'MIGRATION_INVENTORY_CHANGED_DURING_ASSEMBLY'
  )
  const currentNames = readdirSync(inventory.path, { withFileTypes: true })
    .filter((entry) => /^(\d{14})_([a-z0-9][a-z0-9_]*)\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const expectedNames = inventory.migrations
    .map((migration) => path.basename(migration.path))
    .sort()
  if (JSON.stringify(currentNames) !== JSON.stringify(expectedNames)) {
    fail('MIGRATION_INVENTORY_CHANGED_DURING_ASSEMBLY')
  }
  for (const migration of inventory.migrations) {
    assertPinnedFileUnchanged(migration.file, 'MIGRATION_INVENTORY_CHANGED_DURING_ASSEMBLY')
  }
}

function assertRegularOwnedFile(target, expected, code) {
  const record = readPinnedFile(target, code)
  const stat = record.identity
  const effectiveUserId = effectiveOwnerUid(code)
  if (
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    stat.size !== expected.size ||
    stat.uid !== effectiveUserId ||
    (stat.mode & 0o077) !== 0 ||
    record.sha256 !== expected.sha256
  ) {
    fail(code)
  }
}

function assertPublishedEntries(target, targetIdentity, ownedEntries, expectedNames) {
  assertDirectoryIdentity(target, targetIdentity, 'CANDIDATE_OUTPUT_CHANGED_DURING_ASSEMBLY')
  const targetStat = lstatSync(target)
  const effectiveUserId = effectiveOwnerUid('CANDIDATE_OUTPUT_CHANGED_DURING_ASSEMBLY')
  if ((targetStat.mode & 0o077) !== 0 || targetStat.uid !== effectiveUserId) {
    fail('CANDIDATE_OUTPUT_CHANGED_DURING_ASSEMBLY')
  }
  if (realpathSync(target) !== target) fail('CANDIDATE_OUTPUT_CHANGED_DURING_ASSEMBLY')
  const names = readdirSync(target).sort()
  if (JSON.stringify(names) !== JSON.stringify([...expectedNames].sort())) {
    fail('CANDIDATE_OUTPUT_ARTIFACT_SET_INVALID')
  }
  for (const name of names) {
    const expected = ownedEntries.get(name)
    if (!expected) fail('CANDIDATE_OUTPUT_ARTIFACT_IDENTITY_INVALID')
    assertRegularOwnedFile(
      path.join(target, name),
      expected,
      'CANDIDATE_OUTPUT_ARTIFACT_IDENTITY_INVALID'
    )
  }
}

function removeOwnedOutput(target, targetIdentity, ownedEntries) {
  assertPublishedEntries(target, targetIdentity, ownedEntries, [...ownedEntries.keys()])
  // Keep the incomplete marker present until every candidate artifact is gone.
  // A partial cleanup must never make an unvalidated directory look committed.
  for (const name of ownedEntries.keys()) {
    if (name !== INCOMPLETE_MARKER) unlinkSync(path.join(target, name))
  }
  if (ownedEntries.has(INCOMPLETE_MARKER)) unlinkSync(path.join(target, INCOMPLETE_MARKER))
  rmdirSync(target)
}

function removeStage(stageRoot, expectedIdentity) {
  if (!stageRoot) return
  assertDirectoryIdentity(stageRoot, expectedIdentity, 'ASSEMBLY_STAGE_CHANGED')
  if (realpathSync(stageRoot) !== stageRoot) fail('ASSEMBLY_STAGE_CHANGED')
  rmSync(stageRoot, { force: true, recursive: true })
}

export function assembleCanonicalBaselineCandidate({
  baselineThrough,
  beforePublish = () => undefined,
  candidateName,
  candidatesRoot,
  commitOutputMarker = unlinkSync,
  foundationPath,
  forwardMigrationPaths,
  platformPrerequisitesPath,
  projectRefSha256,
  publishLink = linkSync,
  repoRoot = REPO_ROOT,
  sourceCaptureDir,
  sourceGitSha,
} = {}) {
  validateExplicitValues({
    baselineThrough,
    candidateName,
    forwardMigrationPaths,
    projectRefSha256,
    sourceGitSha,
  })
  if (typeof beforePublish !== 'function' || typeof commitOutputMarker !== 'function') {
    fail('ASSEMBLY_HOOK_INVALID')
  }
  if (typeof publishLink !== 'function') fail('ASSEMBLY_HOOK_INVALID')

  const requestedRepoRoot = path.resolve(repoRoot)
  const repoStat = lstatSync(requestedRepoRoot)
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) fail('REPOSITORY_ROOT_INVALID')
  const physicalRepoRoot = realpathSync(requestedRepoRoot)
  assertOwnerControlledDirectory(physicalRepoRoot, 'REPOSITORY_ROOT_NOT_OWNER_CONTROLLED')
  const repoIdentity = directoryIdentity(physicalRepoRoot, 'REPOSITORY_ROOT_INVALID')
  const expectedCandidatesRoot = path.join(physicalRepoRoot, 'supabase', 'baseline-candidates')
  const requestedCandidatesRoot = path.resolve(candidatesRoot ?? expectedCandidatesRoot)
  assertNoSymlinkComponents(
    physicalRepoRoot,
    requestedCandidatesRoot,
    'BASELINE_CANDIDATES_ROOT_INVALID'
  )
  const physicalCandidatesRoot = realpathSync(requestedCandidatesRoot)
  if (physicalCandidatesRoot !== expectedCandidatesRoot) fail('BASELINE_CANDIDATES_ROOT_INVALID')
  const candidatesParent = path.dirname(physicalCandidatesRoot)
  assertOwnerControlledDirectory(
    candidatesParent,
    'BASELINE_CANDIDATES_PARENT_NOT_OWNER_CONTROLLED'
  )
  const candidatesParentIdentity = directoryIdentity(
    candidatesParent,
    'BASELINE_CANDIDATES_PARENT_INVALID'
  )
  assertOwnerControlledDirectory(
    physicalCandidatesRoot,
    'BASELINE_CANDIDATES_ROOT_NOT_OWNER_CONTROLLED'
  )
  const candidatesIdentity = directoryIdentity(
    physicalCandidatesRoot,
    'BASELINE_CANDIDATES_ROOT_INVALID'
  )
  const target = path.join(physicalCandidatesRoot, candidateName)
  if (pathExists(target)) fail('CANDIDATE_OUTPUT_ALREADY_EXISTS')

  const sourceCapture = readSourceCapture(sourceCaptureDir)
  const sourceDocument = parseJson(
    sourceCapture.files.get('source-catalog.json').contents,
    'SOURCE_CATALOG_INVALID'
  )
  assertSourceBoundary(sourceDocument, baselineThrough)
  const foundationRecord = resolveRepoFile(
    physicalRepoRoot,
    foundationPath,
    FOUNDATION_PATH_PATTERN,
    'FOUNDATION_INPUT_INVALID'
  )
  const prerequisiteRecord = resolveAbsoluteInputFile(
    platformPrerequisitesPath,
    'PLATFORM_PREREQUISITES_INPUT_INVALID'
  )
  const platformPrerequisites = parseJson(
    prerequisiteRecord.contents,
    'PLATFORM_PREREQUISITES_INPUT_INVALID'
  )
  const inventory = readModernMigrationInventory(physicalRepoRoot)
  assertForwardInputs(inventory, baselineThrough, forwardMigrationPaths)
  const artifacts = buildArtifacts({
    baselineThrough,
    foundationPath,
    foundationRecord,
    inventory,
    platformPrerequisites,
    projectRefSha256,
    sourceCapture,
    sourceDocument,
    sourceGitSha,
  })

  let stageRoot = null
  let stageIdentity = null
  let targetIdentity = null
  const ownedEntries = new Map()
  try {
    stageRoot = mkdtempSync(
      path.join(path.dirname(physicalCandidatesRoot), '.arena-baseline-candidate-stage-')
    )
    assertOwnerControlledDirectory(stageRoot, 'ASSEMBLY_STAGE_INVALID', {
      privateDirectory: true,
    })
    stageIdentity = directoryIdentity(stageRoot, 'ASSEMBLY_STAGE_INVALID')
    const stagedArtifacts = path.join(stageRoot, 'artifacts')
    writeArtifacts(stagedArtifacts, artifacts)
    validatePrivateStage({
      artifacts,
      candidateName,
      foundationPath,
      foundationRecord,
      inventory,
      stageRoot,
    })

    beforePublish()
    assertOwnerControlledHierarchy({
      candidatesIdentity,
      candidatesParent,
      candidatesParentIdentity,
      physicalCandidatesRoot,
      physicalRepoRoot,
      repoIdentity,
    })
    assertCaptureUnchanged(sourceCapture)
    assertPinnedFileUnchanged(foundationRecord, 'FOUNDATION_CHANGED_DURING_ASSEMBLY')
    assertPinnedFileUnchanged(prerequisiteRecord, 'PLATFORM_PREREQUISITES_CHANGED_DURING_ASSEMBLY')
    assertInventoryUnchanged(inventory)
    if (pathExists(target)) fail('CANDIDATE_OUTPUT_ALREADY_EXISTS')

    try {
      mkdirSync(target, { mode: 0o700 })
    } catch (error) {
      if (error?.code === 'EEXIST') fail('CANDIDATE_OUTPUT_ALREADY_EXISTS')
      fail('CANDIDATE_OUTPUT_CLAIM_FAILED', error)
    }
    targetIdentity = directoryIdentity(target, 'CANDIDATE_OUTPUT_CLAIM_FAILED')
    assertOwnerControlledHierarchy({
      candidatesIdentity,
      candidatesParent,
      candidatesParentIdentity,
      physicalCandidatesRoot,
      physicalRepoRoot,
      repoIdentity,
    })
    assertOwnerControlledDirectory(target, 'CANDIDATE_OUTPUT_CLAIM_FAILED', {
      privateDirectory: true,
    })
    const markerPath = path.join(target, INCOMPLETE_MARKER)
    const markerContents = Buffer.from('incomplete\n')
    writeExclusive(markerPath, markerContents)
    ownedEntries.set(INCOMPLETE_MARKER, {
      ...identity(lstatSync(markerPath)),
      sha256: sha256(markerContents),
    })
    for (const name of CANDIDATE_ARTIFACTS) {
      const sourcePath = path.join(stagedArtifacts, name)
      const sourceIdentity = identity(lstatSync(sourcePath))
      publishLink(sourcePath, path.join(target, name))
      ownedEntries.set(name, { ...sourceIdentity, sha256: sha256(artifacts.get(name)) })
    }
    assertPublishedEntries(target, targetIdentity, ownedEntries, [
      ...CANDIDATE_ARTIFACTS,
      INCOMPLETE_MARKER,
    ])
    assertOwnerControlledHierarchy({
      candidatesIdentity,
      candidatesParent,
      candidatesParentIdentity,
      physicalCandidatesRoot,
      physicalRepoRoot,
      repoIdentity,
    })

    assertCaptureUnchanged(sourceCapture)
    assertPinnedFileUnchanged(foundationRecord, 'FOUNDATION_CHANGED_DURING_ASSEMBLY')
    assertPinnedFileUnchanged(prerequisiteRecord, 'PLATFORM_PREREQUISITES_CHANGED_DURING_ASSEMBLY')
    assertInventoryUnchanged(inventory)
    removeStage(stageRoot, stageIdentity)
    stageRoot = null
    stageIdentity = null

    commitOutputMarker(markerPath)
    assertOwnerControlledHierarchy({
      candidatesIdentity,
      candidatesParent,
      candidatesParentIdentity,
      physicalCandidatesRoot,
      physicalRepoRoot,
      repoIdentity,
    })
    ownedEntries.delete(INCOMPLETE_MARKER)
    assertPublishedEntries(target, targetIdentity, ownedEntries, CANDIDATE_ARTIFACTS)
    const validation = validateBaselineCandidate({
      candidateDir: target,
      candidatesRoot: physicalCandidatesRoot,
      repoRoot: physicalRepoRoot,
    })
    assertOwnerControlledHierarchy({
      candidatesIdentity,
      candidatesParent,
      candidatesParentIdentity,
      physicalCandidatesRoot,
      physicalRepoRoot,
      repoIdentity,
    })
    assertPublishedEntries(target, targetIdentity, ownedEntries, CANDIDATE_ARTIFACTS)
    return Object.freeze({
      ...validation,
      artifactCount: CANDIDATE_ARTIFACTS.length,
      manifestSha256: sha256(artifacts.get('manifest.json')),
    })
  } catch (error) {
    let cleanupFailed = false
    if (targetIdentity !== null) {
      try {
        const markerPath = path.join(target, INCOMPLETE_MARKER)
        if (!pathExists(markerPath)) {
          assertDirectoryIdentity(
            target,
            targetIdentity,
            'CANDIDATE_OUTPUT_CHANGED_DURING_ASSEMBLY'
          )
          writeExclusive(markerPath, Buffer.from('incomplete\n'))
          ownedEntries.set(INCOMPLETE_MARKER, {
            ...identity(lstatSync(markerPath)),
            sha256: sha256(Buffer.from('incomplete\n')),
          })
        }
        removeOwnedOutput(target, targetIdentity, ownedEntries)
      } catch {
        cleanupFailed = true
      }
    }
    try {
      removeStage(stageRoot, stageIdentity)
    } catch {
      cleanupFailed = true
    }
    if (cleanupFailed) fail('ASSEMBLY_CLEANUP_FAILED', error)
    throw error
  }
}

function parseCliArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const values = new Map()
  const forwardMigrationPaths = []
  let explicitEmptyForwardSet = false
  const singleValueFlags = new Set([
    '--baseline-through',
    '--candidate-name',
    '--foundation',
    '--platform-prerequisites',
    '--project-ref-sha256',
    '--source-capture-dir',
    '--source-git-sha',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--no-forward-migrations') {
      if (explicitEmptyForwardSet) fail('CLI_ARGUMENTS_INVALID')
      explicitEmptyForwardSet = true
      continue
    }
    if (flag === '--forward-migration') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('CLI_ARGUMENTS_INVALID')
      forwardMigrationPaths.push(value)
      index += 1
      continue
    }
    if (!singleValueFlags.has(flag) || values.has(flag)) fail('CLI_ARGUMENTS_INVALID')
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail('CLI_ARGUMENTS_INVALID')
    values.set(flag, value)
    index += 1
  }
  if (
    values.size !== singleValueFlags.size ||
    (explicitEmptyForwardSet && forwardMigrationPaths.length > 0) ||
    (!explicitEmptyForwardSet && forwardMigrationPaths.length === 0)
  ) {
    fail('CLI_ARGUMENTS_INVALID')
  }
  return {
    baselineThrough: values.get('--baseline-through'),
    candidateName: values.get('--candidate-name'),
    foundationPath: values.get('--foundation'),
    forwardMigrationPaths,
    platformPrerequisitesPath: values.get('--platform-prerequisites'),
    projectRefSha256: values.get('--project-ref-sha256'),
    sourceCaptureDir: values.get('--source-capture-dir'),
    sourceGitSha: values.get('--source-git-sha'),
  }
}

function usage() {
  return (
    'Usage: node scripts/maintenance/assemble-canonical-baseline-candidate.mjs ' +
    '--candidate-name <name> --source-capture-dir <absolute-completed-capture> ' +
    '--source-git-sha <40-hex> --project-ref-sha256 <64-hex> ' +
    '--foundation <supabase/baseline-foundations/file.sql> ' +
    '--platform-prerequisites <absolute-json> --baseline-through <14-digits> ' +
    '(--forward-migration <supabase/migrations/file.sql> ... | --no-forward-migrations)\n'
  )
}

export function runCli({
  argv = process.argv.slice(2),
  assemble = assembleCanonicalBaselineCandidate,
  writeError = (value) => process.stderr.write(value),
  writeOutput = (value) => process.stdout.write(value),
} = {}) {
  let options
  try {
    options = parseCliArguments(argv)
  } catch {
    writeError(usage())
    return 2
  }
  if (options.help) {
    writeOutput(usage())
    return 0
  }
  try {
    const result = assemble(options)
    writeOutput(
      `Canonical baseline candidate published (${result.artifactCount} artifacts; ${CANDIDATE_STATUS}).\n`
    )
    return 0
  } catch {
    writeError('Canonical baseline candidate assembly refused: ASSEMBLY_FAILED\n')
    return 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runCli()
}

export const _assemblerContractForTests = Object.freeze({
  candidateArtifacts: CANDIDATE_ARTIFACTS,
  captureArtifacts: CAPTURE_ARTIFACTS,
  incompleteMarker: INCOMPLETE_MARKER,
  parseCliArguments,
})
