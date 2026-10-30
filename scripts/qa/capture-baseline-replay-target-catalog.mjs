#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { devNull } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { CATALOG_QUERIES, canonicalRows } from '../maintenance/capture-canonical-baseline.mjs'
import { containsBaselineCredentialLikeData } from './baseline-credential-safety.mjs'
import {
  SOURCE_CATALOG_KEYS,
  validateSourceCatalogRowContracts,
} from './baseline-source-catalog-contract.mjs'

const MAX_CATALOG_BYTES = 64 * 1024 * 1024
const PSQL_TIMEOUT_MS = 65_000
const SOCKET_NAME_PATTERN = /^arena-baseline-pg17-socket\.[A-Za-z0-9]+$/u
const DIRECTORY_IDENTITY_FIELDS = Object.freeze(['dev', 'ino', 'uid', 'gid', 'mode'])
const FILE_IDENTITY_FIELDS = Object.freeze([
  'dev',
  'ino',
  'uid',
  'gid',
  'mode',
  'nlink',
  'size',
  'mtimeMs',
  'ctimeMs',
])

function fail(message) {
  throw new Error(message)
}

function effectiveUserId() {
  if (typeof process.geteuid !== 'function') fail('effective user identity is unavailable')
  return process.geteuid()
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function identity(metadata, fields) {
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, metadata[field]])))
}

function assertIdentity(actual, expected, fields, label) {
  if (fields.some((field) => actual[field] !== expected[field])) {
    fail(`${label} changed during target catalogue capture`)
  }
}

function assertPrivateSocketDirectory(socketPath) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    fail('socket path must be an absolute harness-owned directory')
  }
  if (!SOCKET_NAME_PATTERN.test(path.basename(socketPath))) {
    fail('socket path must use the baseline replay harness prefix')
  }
  const requested = lstatSync(socketPath)
  if (requested.isSymbolicLink() || !requested.isDirectory()) {
    fail('socket path must be a real directory, not a symlink')
  }
  const physical = realpathSync(socketPath)
  const physicalParent = realpathSync(path.dirname(physical))
  const allowedParents = new Set()
  for (const entry of ['/tmp', '/private/tmp']) {
    try {
      allowedParents.add(realpathSync(entry))
    } catch {}
  }
  if (!allowedParents.has(physicalParent)) {
    fail('socket path must stay directly below the system temporary directory')
  }
  const effectiveUser = effectiveUserId()
  if (requested.uid !== effectiveUser || (requested.mode & 0o777) !== 0o700) {
    fail('socket path must be owned by the effective user with mode 0700')
  }
  return Object.freeze({
    identity: identity(requested, DIRECTORY_IDENTITY_FIELDS),
    path: physical,
    requestedPath: socketPath,
  })
}

function inspectPsql(psqlPath) {
  if (typeof psqlPath !== 'string' || !path.isAbsolute(psqlPath)) {
    fail('psql path must be absolute')
  }
  const requested = lstatSync(psqlPath)
  if (!requested.isFile() && !requested.isSymbolicLink()) {
    fail('psql path must name an executable file')
  }
  const physical = realpathSync(psqlPath)
  const physicalParent = path.dirname(physical)
  const parentMetadata = lstatSync(physicalParent)
  const effectiveUser = effectiveUserId()
  if (
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    realpathSync(physicalParent) !== physicalParent ||
    ![0, effectiveUser].includes(parentMetadata.uid) ||
    (parentMetadata.mode & 0o022) !== 0
  ) {
    fail('psql physical parent must be root/effective-user-owned and not group/world writable')
  }
  let descriptor
  try {
    if (fsConstants.O_NOFOLLOW === undefined) fail('O_NOFOLLOW is required to inspect psql')
    descriptor = openSync(physical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = fstatSync(descriptor)
    if (
      !before.isFile() ||
      ![0, effectiveUser].includes(before.uid) ||
      (before.mode & 0o022) !== 0
    ) {
      fail('psql must be a root/effective-user-owned non-writable regular file')
    }
    accessSync(physical, fsConstants.X_OK)
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const finalPath = lstatSync(physical)
    assertIdentity(after, before, FILE_IDENTITY_FIELDS, 'psql')
    assertIdentity(finalPath, before, FILE_IDENTITY_FIELDS, 'psql')
    if (!finalPath.isFile() || realpathSync(psqlPath) !== physical) {
      fail('psql changed during target catalogue capture')
    }
    return Object.freeze({
      identity: Object.freeze({
        ...identity(before, FILE_IDENTITY_FIELDS),
        sha256: sha256(contents),
      }),
      path: physical,
      physicalParent: Object.freeze({
        identity: identity(parentMetadata, DIRECTORY_IDENTITY_FIELDS),
        path: physicalParent,
      }),
      requestedIdentity: identity(requested, FILE_IDENTITY_FIELDS),
      requestedPath: psqlPath,
    })
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function assertOutputPath(outputPath) {
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) {
    fail('output path must be absolute')
  }
  const parent = path.dirname(outputPath)
  const stat = lstatSync(parent)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('output parent must be a real directory, not a symlink')
  }
  const physicalParent = realpathSync(parent)
  const effectiveUser = effectiveUserId()
  if (stat.uid !== effectiveUser || (stat.mode & 0o022) !== 0) {
    fail('output parent must be effective-user-owned and not group/world writable')
  }
  try {
    lstatSync(outputPath)
    fail('output path must not already exist')
  } catch (error) {
    if (error?.message === 'output path must not already exist') throw error
    if (error?.code !== 'ENOENT') throw error
  }
  return Object.freeze({
    parent: Object.freeze({
      identity: identity(stat, DIRECTORY_IDENTITY_FIELDS),
      path: physicalParent,
    }),
    path: path.join(physicalParent, path.basename(outputPath)),
  })
}

function psqlEnvironment(socketPath) {
  const unavailableHome = path.join(socketPath, '.arena-no-home')
  return {
    HOME: unavailableHome,
    LC_ALL: 'C',
    LANG: 'C',
    PAGER: '',
    PGPASSFILE: devNull,
    PGSERVICEFILE: devNull,
    PGSYSCONFDIR: unavailableHome,
    PSQL_PAGER: '',
    PSQLRC: devNull,
    TZ: 'UTC',
    XDG_CONFIG_HOME: unavailableHome,
  }
}

function assertSocketUnchanged(socket) {
  const current = lstatSync(socket.requestedPath)
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    realpathSync(socket.requestedPath) !== socket.path ||
    current.uid !== effectiveUserId() ||
    (current.mode & 0o777) !== 0o700
  ) {
    fail('socket path changed during target catalogue capture')
  }
  assertIdentity(current, socket.identity, DIRECTORY_IDENTITY_FIELDS, 'socket path')
}

function assertOutputParentUnchanged(output) {
  const current = lstatSync(output.parent.path)
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    realpathSync(output.parent.path) !== output.parent.path ||
    current.uid !== effectiveUserId() ||
    (current.mode & 0o022) !== 0
  ) {
    fail('output parent changed during target catalogue capture')
  }
  assertIdentity(current, output.parent.identity, DIRECTORY_IDENTITY_FIELDS, 'output parent')
}

function assertPsqlUnchanged(psql) {
  const current = inspectPsql(psql.requestedPath)
  assertIdentity(current.requestedIdentity, psql.requestedIdentity, FILE_IDENTITY_FIELDS, 'psql')
  assertIdentity(current.identity, psql.identity, FILE_IDENTITY_FIELDS, 'psql')
  if (current.path !== psql.path || current.identity.sha256 !== psql.identity.sha256) {
    fail('psql changed during target catalogue capture')
  }
  if (current.physicalParent.path !== psql.physicalParent.path) {
    fail('psql physical parent changed during target catalogue capture')
  }
  assertIdentity(
    current.physicalParent.identity,
    psql.physicalParent.identity,
    DIRECTORY_IDENTITY_FIELDS,
    'psql physical parent'
  )
}

function assertRuntimeBoundaries({ output, psql, socket }) {
  assertSocketUnchanged(socket)
  assertOutputParentUnchanged(output)
  assertPsqlUnchanged(psql)
}

function publishCatalog(output, serialized, runtime) {
  if (fsConstants.O_NOFOLLOW === undefined) fail('O_NOFOLLOW is required to publish catalogue')
  assertRuntimeBoundaries(runtime)
  const bytes = Buffer.from(serialized, 'utf8')
  let descriptor
  let publishedIdentity = null
  try {
    descriptor = openSync(
      output.path,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    )
    fchmodSync(descriptor, 0o600)
    const created = fstatSync(descriptor)
    if (
      !created.isFile() ||
      created.uid !== effectiveUserId() ||
      (created.mode & 0o777) !== 0o600 ||
      created.nlink !== 1
    ) {
      fail('published catalogue file identity is unsafe')
    }
    publishedIdentity = identity(created, ['dev', 'ino', 'uid'])
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    const readback = Buffer.alloc(bytes.length)
    let offset = 0
    while (offset < readback.length) {
      const count = readSync(descriptor, readback, offset, readback.length - offset, offset)
      if (count === 0) fail('published catalogue readback was truncated')
      offset += count
    }
    const after = fstatSync(descriptor)
    const pathMetadata = lstatSync(output.path)
    if (
      !after.isFile() ||
      after.dev !== created.dev ||
      after.ino !== created.ino ||
      after.uid !== effectiveUserId() ||
      (after.mode & 0o777) !== 0o600 ||
      after.nlink !== 1 ||
      after.size !== bytes.length ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      pathMetadata.dev !== after.dev ||
      pathMetadata.ino !== after.ino ||
      !readback.equals(bytes)
    ) {
      fail('published catalogue failed pinned readback verification')
    }
    assertRuntimeBoundaries(runtime)
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {}
      descriptor = undefined
    }
    if (publishedIdentity !== null) {
      try {
        const current = lstatSync(output.path)
        if (
          !current.isSymbolicLink() &&
          current.isFile() &&
          current.dev === publishedIdentity.dev &&
          current.ino === publishedIdentity.ino &&
          current.uid === publishedIdentity.uid
        ) {
          unlinkSync(output.path)
        }
      } catch {}
    }
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function fixedCatalogSql(query) {
  const fixed = query.replaceAll('$1::text[]', "ARRAY['arena', 'public']::text[]").trim()
  if (/\$\d/u.test(fixed)) fail('target catalogue query contains an unbound parameter')
  return `
BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, MDY';
SET LOCAL extra_float_digits = 3;
SELECT COALESCE(
  pg_catalog.json_agg(pg_catalog.row_to_json(arena_catalog_row)),
  '[]'::json
)
FROM (
${fixed}
) AS arena_catalog_row;
COMMIT;
`
}

function parseRows(output, label) {
  let rows
  try {
    rows = JSON.parse(output.trim())
  } catch {
    fail(`target catalogue ${label} query returned invalid JSON`)
  }
  return canonicalRows(rows, `target_${label}`)
}

export function captureBaselineReplayTargetCatalog({
  outputPath,
  psqlPath,
  runner = spawnSync,
  socketPath,
} = {}) {
  const psql = inspectPsql(psqlPath)
  const socket = assertPrivateSocketDirectory(socketPath)
  const output = assertOutputPath(outputPath)
  const runtime = { output, psql, socket }
  const catalog = {}

  for (const key of SOURCE_CATALOG_KEYS) {
    const query = CATALOG_QUERIES[key]
    if (typeof query !== 'string') fail(`target catalogue query is missing for ${key}`)
    assertRuntimeBoundaries(runtime)
    let result
    try {
      result = runner(
        psql.path,
        [
          '-h',
          socket.path,
          '-p',
          '5432',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-X',
          '-w',
          '-q',
          '-At',
          '-P',
          'pager=off',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          fixedCatalogSql(query),
        ],
        {
          encoding: 'utf8',
          env: psqlEnvironment(socket.path),
          killSignal: 'SIGKILL',
          maxBuffer: MAX_CATALOG_BYTES,
          timeout: PSQL_TIMEOUT_MS,
        }
      )
    } finally {
      assertRuntimeBoundaries(runtime)
    }
    if (result?.error || result?.signal || result?.status !== 0) {
      fail(`target catalogue ${key} query failed`)
    }
    catalog[key] = parseRows(result.stdout, key)
  }

  validateSourceCatalogRowContracts(catalog, {
    fail: (message) => fail(`target catalogue contract failed: ${message}`),
  })
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`
  if (containsBaselineCredentialLikeData(serialized)) {
    fail('target catalogue contains credential-like data')
  }
  publishCatalog(output, serialized, runtime)
  return { catalog, categoryCount: SOURCE_CATALOG_KEYS.length }
}

export function main(argv = process.argv.slice(2)) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (!['--output', '--psql', '--socket'].includes(option) || value === undefined) {
      process.stderr.write(
        'Usage: node scripts/qa/capture-baseline-replay-target-catalog.mjs --psql <absolute-path> --socket <harness-socket> --output <new-file>\n'
      )
      process.exitCode = 2
      return
    }
    if (values.has(option)) {
      process.stderr.write(`Target catalogue capture refused: duplicate option ${option}\n`)
      process.exitCode = 1
      return
    }
    values.set(option, value)
  }
  if (values.size !== 3) {
    process.stderr.write(
      'Usage: node scripts/qa/capture-baseline-replay-target-catalog.mjs --psql <absolute-path> --socket <harness-socket> --output <new-file>\n'
    )
    process.exitCode = 2
    return
  }
  try {
    const result = captureBaselineReplayTargetCatalog({
      outputPath: values.get('--output'),
      psqlPath: values.get('--psql'),
      socketPath: values.get('--socket'),
    })
    process.stdout.write(
      `BASELINE REPLAY WITNESS: captured ${result.categoryCount} target catalogue categories (local dependency evidence only)\n`
    )
  } catch (error) {
    process.stderr.write(`Target catalogue capture refused: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
