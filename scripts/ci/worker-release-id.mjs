#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const CONTRACT = 'arena.worker-release-inputs@1\0'
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const REQUIRED_FILES = [
  '.github/workflows/build-ingest-image.yml',
  '.github/workflows/deploy-ingest-sg.yml',
  '.dockerignore',
  '.npmrc',
  'package-lock.json',
  'package.json',
  'scripts/ci/worker-release-id.mjs',
  'tsconfig.json',
]
const REQUIRED_TREES = ['lib', 'worker']
const ALLOWED_MODES = new Set(['100644', '100755', '120000'])
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const OBJECT_ID = /^[0-9a-f]+$/u
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function gitEnvironment(env) {
  return {
    ...env,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
}

function runGit(repoPath, args, env) {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    env: gitEnvironment(env),
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return {
    error: result.error,
    status: result.status,
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
  }
}

function resolveCommit(repoPath, ref, env) {
  const result = runGit(
    repoPath,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    env
  )
  if (result.error || result.status !== 0) {
    throw new Error('worker release ref does not resolve to a commit')
  }
  if (result.stderr.length !== 0) {
    throw new Error('git commit resolution output is malformed')
  }

  const output = result.stdout.toString('ascii')
  if (!/^[0-9a-f]+\n$/u.test(output)) {
    throw new Error('git commit resolution output is malformed')
  }
  const commit = output.slice(0, -1)
  if (!OBJECT_ID.test(commit) || (commit.length !== 40 && commit.length !== 64)) {
    throw new Error('git commit resolution output is malformed')
  }
  return commit
}

function decodePath(pathBuffer) {
  let path
  try {
    path = textDecoder.decode(pathBuffer)
  } catch {
    throw new Error('git tree output contains a malformed path')
  }

  const segments = path.split('/')
  if (
    pathBuffer.length === 0 ||
    pathBuffer.length > 4096 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    CONTROL_CHARACTER.test(path) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment) > 255
    )
  ) {
    throw new Error('git tree output contains a malformed path')
  }

  const allowed =
    REQUIRED_FILES.includes(path) || REQUIRED_TREES.some((tree) => path.startsWith(`${tree}/`))
  if (!allowed) {
    throw new Error('git tree output contains an out-of-scope path')
  }
  return path
}

function parseTreeOutput(rawOutput, objectIdLength) {
  if (rawOutput.length === 0) return []
  if (rawOutput.at(-1) !== 0) throw new Error('git tree output is malformed')

  const entries = []
  const paths = new Set()
  let offset = 0
  while (offset < rawOutput.length) {
    const recordEnd = rawOutput.indexOf(0, offset)
    if (recordEnd < 0 || recordEnd === offset) throw new Error('git tree output is malformed')
    const record = rawOutput.subarray(offset, recordEnd)
    const separator = record.indexOf(9)
    if (separator <= 0 || separator === record.length - 1) {
      throw new Error('git tree output record is malformed')
    }

    const metadata = record.subarray(0, separator).toString('ascii')
    const match = /^(\d{6}) (\S+) ([0-9a-f]+)$/u.exec(metadata)
    if (
      !match ||
      !ALLOWED_MODES.has(match[1]) ||
      match[2] !== 'blob' ||
      match[3].length !== objectIdLength ||
      !OBJECT_ID.test(match[3])
    ) {
      throw new Error('git tree output record is malformed')
    }

    const pathBuffer = record.subarray(separator + 1)
    const path = decodePath(pathBuffer)
    if (paths.has(path)) throw new Error('git tree output contains a duplicate path')
    paths.add(path)
    entries.push({ mode: match[1], objectId: match[3], path, pathBuffer })
    offset = recordEnd + 1
  }
  return entries
}

function requireDeploymentInputs(entries) {
  const paths = new Set(entries.map((entry) => entry.path))
  for (const file of REQUIRED_FILES) {
    if (!paths.has(file)) throw new Error(`required worker release input is missing: ${file}`)
  }
  for (const tree of REQUIRED_TREES) {
    if (!entries.some((entry) => entry.path.startsWith(`${tree}/`))) {
      throw new Error(`required worker release input tree is missing: ${tree}/**`)
    }
  }
}

function hashEntries(entries) {
  const hash = createHash('sha256')
  hash.update(CONTRACT, 'utf8')

  entries.sort((left, right) => Buffer.compare(left.pathBuffer, right.pathBuffer))
  for (const entry of entries) {
    hash.update(entry.mode, 'ascii')
    hash.update(' blob ', 'ascii')
    hash.update(entry.objectId, 'ascii')
    hash.update('\t', 'ascii')
    hash.update(entry.pathBuffer)
    hash.update('\0', 'ascii')
  }
  return hash.digest('hex')
}

/**
 * Derive the worker source/deployment identity from committed Git inputs only.
 *
 * @param {string} ref a Git ref or commit that peels to a commit
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {string} a 64-character lowercase SHA-256 digest
 */
export function computeWorkerReleaseId(
  ref = 'HEAD',
  { cwd = process.cwd(), env = process.env } = {}
) {
  if (
    typeof ref !== 'string' ||
    ref.length === 0 ||
    ref.trim() !== ref ||
    CONTROL_CHARACTER.test(ref)
  ) {
    throw new Error('worker release ref must be a non-empty commit/ref')
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) {
    throw new Error('worker release repository path is invalid')
  }

  const repoPath = resolve(cwd)
  const commit = resolveCommit(repoPath, ref, env)
  const tree = runGit(
    repoPath,
    ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...REQUIRED_TREES, ...REQUIRED_FILES],
    env
  )
  if (tree.error || tree.status !== 0) {
    throw new Error('unable to read worker release inputs from commit')
  }
  if (tree.stderr.length !== 0) throw new Error('git tree output is malformed')

  const entries = parseTreeOutput(tree.stdout, commit.length)
  requireDeploymentInputs(entries)
  const releaseId = hashEntries(entries)
  if (!/^[0-9a-f]{64}$/u.test(releaseId)) throw new Error('worker release ID output is malformed')
  return releaseId
}

const invokedAsScript =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedAsScript) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1) throw new Error('usage: worker-release-id.mjs [commit-or-ref]')
    process.stdout.write(`${computeWorkerReleaseId(args[0] ?? 'HEAD')}\n`)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'worker release ID computation failed'}\n`
    )
    process.exitCode = 1
  }
}
