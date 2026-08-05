import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { computeWorkerReleaseId } from '../ci/worker-release-id.mjs'

const SCRIPT = fileURLToPath(new URL('../ci/worker-release-id.mjs', import.meta.url))
const FORGE_STD_COMMIT = '1801b0541f4fda118a10798fd3486bb7051c5dd6'
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'worker-release-test@example.com',
  GIT_AUTHOR_NAME: 'Worker Release Test',
  GIT_COMMITTER_EMAIL: 'worker-release-test@example.com',
  GIT_COMMITTER_NAME: 'Worker Release Test',
  LC_ALL: 'C',
}

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim()
}

function put(repo, path, contents) {
  const destination = join(repo, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, contents)
}

function commit(repo, message) {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'arena-worker-release-id-'))
  t.after(() => rmSync(repo, { force: true, recursive: true }))
  git(repo, 'init', '-q')
  put(repo, '.dockerignore', '.env*\nnode_modules\nlib/forge-std\n')
  put(repo, '.github/workflows/build-ingest-image.yml', 'name: build worker\n')
  put(repo, '.github/workflows/deploy-ingest-sg.yml', 'name: deploy worker\n')
  put(repo, '.github/dependabot.yml', 'version: 2\nupdates: []\n')
  put(repo, '.npmrc', 'root-app-only=true\n')
  put(repo, 'package.json', '{"name":"app-fixture","private":true}\n')
  put(repo, 'package-lock.json', '{"name":"app-fixture","lockfileVersion":3}\n')
  put(repo, 'tsconfig.json', '{"compilerOptions":{"jsx":"preserve"}}\n')
  put(repo, 'worker/.npmrc', 'engine-strict=true\n')
  put(repo, 'worker/package.json', '{"name":"worker-release-fixture","private":true}\n')
  put(repo, 'worker/package-lock.json', '{"name":"worker-release-fixture","lockfileVersion":3}\n')
  put(repo, 'worker/tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
  put(repo, 'worker/index.ts', 'export const worker = true\n')
  put(repo, 'lib/shared.ts', 'export const shared = true\n')
  put(repo, 'scripts/ci/worker-release-id.mjs', 'export const contract = 1\n')
  put(repo, 'app/page.tsx', 'export default function Page() { return null }\n')
  put(repo, 'docs/readme.md', '# fixture\n')
  const base = commit(repo, 'base')
  return { base, repo }
}

test('returns one deterministic lowercase SHA-256 from an import or the CLI', (t) => {
  const { base, repo } = makeRepo(t)
  const imported = computeWorkerReleaseId(base, { cwd: repo })
  assert.match(imported, /^[0-9a-f]{64}$/)
  assert.equal(computeWorkerReleaseId('HEAD', { cwd: repo }), imported)

  const cli = execFileSync(process.execPath, [SCRIPT, base], {
    cwd: repo,
    encoding: 'utf8',
  })
  assert.match(cli, /^[0-9a-f]{64}\n$/)
  assert.equal(cli.trim(), imported)
})

test('ignores dirty state and committed app or governance inputs outside the runtime', (t) => {
  const { base, repo } = makeRepo(t)
  const expected = computeWorkerReleaseId(base, { cwd: repo })

  put(repo, 'worker/index.ts', 'dirty but uncommitted\n')
  put(repo, 'lib/untracked.ts', 'untracked\n')
  assert.equal(computeWorkerReleaseId(base, { cwd: repo }), expected)
  git(repo, 'restore', 'worker/index.ts')
  rmSync(join(repo, 'lib/untracked.ts'))

  put(repo, 'app/page.tsx', 'export default function Page() { return <main /> }\n')
  put(repo, 'docs/readme.md', '# unrelated update\n')
  put(repo, '.npmrc', 'root-app-only=false\n')
  put(repo, 'package.json', '{"name":"app-fixture","private":true,"version":"2.0.0"}\n')
  put(repo, 'package-lock.json', '{"name":"app-fixture","lockfileVersion":3,"version":"2.0.0"}\n')
  put(repo, 'tsconfig.json', '{"compilerOptions":{"jsx":"react-jsx"}}\n')
  put(repo, '.github/dependabot.yml', 'version: 2\nupdates:\n  - directory: /worker\n')
  const unrelated = commit(repo, 'root app and governance metadata only')
  assert.equal(computeWorkerReleaseId(unrelated, { cwd: repo }), expected)
})

test('excludes only the Docker-ignored Foundry gitlink from Worker runtime identity', (t) => {
  const { repo } = makeRepo(t)
  const expected = computeWorkerReleaseId('HEAD', { cwd: repo })

  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${FORGE_STD_COMMIT},lib/forge-std`)
  git(repo, 'commit', '-q', '-m', 'add non-runtime Foundry gitlink')
  assert.equal(computeWorkerReleaseId('HEAD', { cwd: repo }), expected)

  git(
    repo,
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${FORGE_STD_COMMIT},lib/unreviewed-submodule`
  )
  git(repo, 'commit', '-q', '-m', 'add unknown runtime-tree gitlink')
  assert.throws(
    () => computeWorkerReleaseId('HEAD', { cwd: repo }),
    /git tree output record is malformed/
  )
})

test('changes when Worker source, shared source, or Worker-owned release inputs change', (t) => {
  const { repo } = makeRepo(t)
  let previous = computeWorkerReleaseId('HEAD', { cwd: repo })
  const changes = [
    ['worker/index.ts', 'export const worker = 2\n'],
    ['lib/shared.ts', 'export const shared = 2\n'],
    ['worker/package.json', '{"name":"worker-release-fixture","private":true,"version":"2.0.0"}\n'],
    [
      'worker/package-lock.json',
      '{"name":"worker-release-fixture","version":"2.0.0","lockfileVersion":3}\n',
    ],
    ['worker/.npmrc', 'engine-strict=false\n'],
    ['.dockerignore', '.env*\nnode_modules\nworker/tests\nlib/forge-std\n'],
    ['.github/workflows/build-ingest-image.yml', 'name: build worker v2\n'],
    ['.github/workflows/deploy-ingest-sg.yml', 'name: deploy worker v2\n'],
    ['scripts/ci/worker-release-id.mjs', 'export const contract = 2\n'],
    ['worker/tsconfig.json', '{"compilerOptions":{"strict":false}}\n'],
  ]

  for (const [path, contents] of changes) {
    put(repo, path, contents)
    const ref = commit(repo, `change ${path}`)
    const next = computeWorkerReleaseId(ref, { cwd: repo })
    assert.notEqual(next, previous, `${path} must affect the release ID`)
    previous = next
  }
})

test('rejects missing release files and a missing shared-source tree', async (t) => {
  const { base, repo } = makeRepo(t)
  const missingInputs = [
    '.dockerignore',
    '.github/workflows/build-ingest-image.yml',
    '.github/workflows/deploy-ingest-sg.yml',
    'worker/.npmrc',
    'worker/package-lock.json',
    'worker/package.json',
    'worker/tsconfig.json',
    'scripts/ci/worker-release-id.mjs',
    'lib/shared.ts',
  ]

  for (const path of missingInputs) {
    git(repo, 'checkout', '-q', base)
    rmSync(join(repo, path))
    const ref = commit(repo, `remove ${path}`)
    const expected = path === 'lib/shared.ts' ? /input tree is missing/ : /input is missing/
    assert.throws(() => computeWorkerReleaseId(ref, { cwd: repo }), expected)
  }
})

test('rejects absent refs, tree/blob objects, and malformed ref arguments', (t) => {
  const { repo } = makeRepo(t)
  const blob = git(repo, 'rev-parse', 'HEAD:worker/index.ts')
  const tree = git(repo, 'rev-parse', 'HEAD:worker')

  for (const ref of ['refs/heads/absent', blob, tree]) {
    assert.throws(() => computeWorkerReleaseId(ref, { cwd: repo }), /does not resolve to a commit/)
  }
  for (const ref of ['', ' HEAD', 'HEAD\n']) {
    assert.throws(() => computeWorkerReleaseId(ref, { cwd: repo }), /non-empty commit\/ref/)
  }
})

test('rejects malformed committed input paths', (t) => {
  const { repo } = makeRepo(t)
  put(repo, 'worker/bad\nname.ts', 'malformed path\n')
  const ref = commit(repo, 'add malformed path')
  assert.throws(
    () => computeWorkerReleaseId(ref, { cwd: repo }),
    /git tree output contains a malformed path/
  )
})

test('fails closed on malformed Git command output and keeps stdout empty', (t) => {
  const { repo } = makeRepo(t)
  const fakeBin = mkdtempSync(join(tmpdir(), 'arena-worker-release-fake-git-'))
  t.after(() => rmSync(fakeBin, { force: true, recursive: true }))
  const fakeGit = join(fakeBin, 'git')
  writeFileSync(
    fakeGit,
    '#!/bin/sh\ncase " $* " in\n  *" rev-parse "*) printf "0123456789012345678901234567890123456789\\n" ;;\n  *) printf "malformed-without-nul" ;;\nesac\n'
  )
  chmodSync(fakeGit, 0o755)
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` }

  assert.throws(
    () => computeWorkerReleaseId('HEAD', { cwd: repo, env }),
    /git tree output is malformed/
  )
  const cli = spawnSync(process.execPath, [SCRIPT, 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    env,
  })
  assert.notEqual(cli.status, 0)
  assert.equal(cli.stdout, '')
  assert.match(cli.stderr, /git tree output is malformed/)
})
