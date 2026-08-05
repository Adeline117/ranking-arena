import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

function isolatedGitEnv(overrides = {}) {
  const env = {}
  for (const key of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = String(value)
  }

  // Never inherit inline config triplets (including sparse KEY/VALUE indexes),
  // repository redirections, or caller-controlled system/global config.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = devNull
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function spawnGit(directory, args, envOverrides = {}) {
  return spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: isolatedGitEnv(envOverrides),
  })
}

function runInstaller(directory, envOverrides = {}) {
  return spawnSync(process.execPath, ['install-git-hooks.mjs'], {
    cwd: directory,
    encoding: 'utf8',
    env: isolatedGitEnv(envOverrides),
  })
}

async function externalHooksCanary(container) {
  const hooksDirectory = join(container, 'external-hooks')
  const globalConfig = join(container, 'malicious-global.gitconfig')
  await mkdir(hooksDirectory)
  await writeFile(join(hooksDirectory, 'canary'), 'must remain unchanged\n')
  await writeFile(globalConfig, `[core]\n\thooksPath = ${hooksDirectory}\n`)
  return {
    hooksDirectory,
    overrides: {
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooksDirectory,
      GIT_CONFIG_KEY_73: 'core.hooksPath',
      GIT_CONFIG_VALUE_73: hooksDirectory,
    },
  }
}

async function copyManagedHookFiles(directory) {
  await copyFile(new URL('install-git-hooks.mjs', root), join(directory, 'install-git-hooks.mjs'))
  await mkdir(join(directory, '.githooks'))
  for (const hookName of ['pre-commit', 'commit-msg']) {
    await copyFile(new URL(`.githooks/${hookName}`, root), join(directory, '.githooks', hookName))
  }
}

async function hooksSnapshot(directory) {
  const entries = (await readdir(directory)).sort()
  return Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry)
      const metadata = await lstat(entryPath)
      return {
        entry,
        mode: metadata.mode,
        content: metadata.isFile() ? (await readFile(entryPath)).toString('base64') : null,
      }
    })
  )
}

async function isolatedCloneFixture(envOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arena-install-git-hooks-'))
  try {
    await copyManagedHookFiles(directory)
    const initialized = spawnGit(directory, ['init', '--quiet'], envOverrides)
    assert.equal(initialized.status, 0, initialized.stderr)

    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test('repository-managed hooks are reproducible in clones and worktrees', async () => {
  const [
    packageJson,
    preCommit,
    commitMessage,
    installer,
    installerStat,
    preCommitStat,
    commitMessageStat,
  ] = await Promise.all([
    source('package.json').then(JSON.parse),
    source('.githooks/pre-commit'),
    source('.githooks/commit-msg'),
    source('install-git-hooks.mjs'),
    lstat(new URL('install-git-hooks.mjs', root)),
    lstat(new URL('.githooks/pre-commit', root)),
    lstat(new URL('.githooks/commit-msg', root)),
  ])

  assert.equal(packageJson.scripts?.prepare, 'node install-git-hooks.mjs')
  assert.equal(packageJson.devDependencies?.['lint-staged'], '^16.4.0')
  assert.deepEqual(Object.keys(packageJson['lint-staged'] ?? {}).sort(), [
    '*.{js,jsx,mjs,cjs}',
    '*.{json,css,md}',
    '*.{ts,tsx}',
  ])
  assert.equal(installerStat.isFile(), true)
  assert.notEqual(installerStat.mode & 0o111, 0)
  assert.notEqual(preCommitStat.mode & 0o111, 0)
  assert.notEqual(commitMessageStat.mode & 0o111, 0)
  assert.match(preCommit, /node_modules\/\.bin\/lint-staged --quiet/)
  assert.match(preCommit, /git diff --cached --diff-filter=A/)
  assert.match(preCommit, /\^\[0-9\]\{14\}_\[a-z0-9_\]\+/)
  assert.doesNotMatch(preCommit, /\bnpx\b/)
  assert.match(commitMessage, /\^debug:/)
  assert.match(commitMessage, /redeploy-trigger commits are not allowed/)
  assert.match(installer, /git[\s\S]*rev-parse[\s\S]*--git-path[\s\S]*hooks/)
  assert.match(installer, /new URL\('\.\/\', import\.meta\.url\)/)
  assert.match(installer, /await lstat\(path\.join\(repositoryRoot, '\.git'\)\)/)
  assert.ok(installer.indexOf('await lstat') < installer.indexOf("spawnSync('git'"))
  assert.match(installer, /\['pre-commit', 'commit-msg'\]/)
  assert.match(installer, /copyFile\(source, destination\)/)
  assert.doesNotMatch(installer, /\.git\/hooks/)
  await assert.rejects(lstat(new URL('scripts/install-git-hooks.mjs', root)), { code: 'ENOENT' })

  const syntax = spawnSync(
    'bash',
    [
      '-n',
      fileURLToPath(new URL('.githooks/pre-commit', root)),
      fileURLToPath(new URL('.githooks/commit-msg', root)),
    ],
    { encoding: 'utf8' }
  )
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('root installer copies the exact executable hooks in a clone', async () => {
  const canaryContainer = await mkdtemp(join(tmpdir(), 'arena-install-git-hooks-canary-'))
  let directory
  try {
    const canary = await externalHooksCanary(canaryContainer)
    const externalBefore = await hooksSnapshot(canary.hooksDirectory)
    const env = isolatedGitEnv(canary.overrides)
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(env.GIT_CONFIG_GLOBAL, devNull)
    assert.equal('GIT_CONFIG_COUNT' in env, false)
    assert.equal(
      Object.keys(env).some((key) => /^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)),
      false
    )

    directory = await isolatedCloneFixture(canary.overrides)
    const installed = runInstaller(directory, canary.overrides)
    assert.equal(installed.status, 0, installed.stderr)

    for (const hookName of ['pre-commit', 'commit-msg']) {
      const sourceHook = await readFile(join(directory, '.githooks', hookName), 'utf8')
      const installedPath = join(directory, '.git', 'hooks', hookName)
      assert.equal(await readFile(installedPath, 'utf8'), sourceHook)
      assert.notEqual((await lstat(installedPath)).mode & 0o111, 0)
    }
    assert.deepEqual(await hooksSnapshot(canary.hooksDirectory), externalBefore)
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
    await rm(canaryContainer, { recursive: true, force: true })
  }
})

test('Vercel snapshot cannot discover or modify an ancestor Git repository', async () => {
  const ancestor = await mkdtemp(join(tmpdir(), 'arena-install-git-hooks-ancestor-'))
  const snapshot = join(ancestor, 'vercel-snapshot')
  try {
    const initialized = spawnGit(ancestor, ['init', '--quiet'])
    assert.equal(initialized.status, 0, initialized.stderr)
    await mkdir(snapshot)
    await copyFile(new URL('install-git-hooks.mjs', root), join(snapshot, 'install-git-hooks.mjs'))

    const hooksDirectory = join(ancestor, '.git', 'hooks')
    const before = await hooksSnapshot(hooksDirectory)
    const installed = runInstaller(snapshot)
    assert.equal(installed.status, 0, installed.stderr)
    assert.deepEqual(await hooksSnapshot(hooksDirectory), before)
    await assert.rejects(lstat(join(snapshot, '.githooks')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(snapshot, '.git')), { code: 'ENOENT' })

    await symlink(join(ancestor, '.git'), join(snapshot, '.git'))
    const rejected = runInstaller(snapshot)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /\.git metadata must be a directory or regular file/)
    assert.deepEqual(await hooksSnapshot(hooksDirectory), before)
  } finally {
    await rm(ancestor, { recursive: true, force: true })
  }
})

test('root installer writes linked-worktree hooks to the common Git directory', async () => {
  const container = await mkdtemp(join(tmpdir(), 'arena-install-git-hooks-worktree-'))
  const primary = join(container, 'primary')
  const linked = join(container, 'linked')
  let envOverrides = {}
  let registered = false
  try {
    const canary = await externalHooksCanary(container)
    envOverrides = canary.overrides
    const externalBefore = await hooksSnapshot(canary.hooksDirectory)
    await mkdir(primary)
    await copyManagedHookFiles(primary)
    let result = spawnGit(primary, ['init', '--quiet'], envOverrides)
    assert.equal(result.status, 0, result.stderr)
    result = spawnGit(primary, ['add', '--', 'install-git-hooks.mjs', '.githooks'], envOverrides)
    assert.equal(result.status, 0, result.stderr)
    result = spawnGit(
      primary,
      [
        '-c',
        'user.name=Arena Hook Contract',
        '-c',
        'user.email=hooks@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'test: hook installer fixture',
      ],
      envOverrides
    )
    assert.equal(result.status, 0, result.stderr)
    result = spawnGit(
      primary,
      ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'],
      envOverrides
    )
    assert.equal(result.status, 0, result.stderr)
    registered = true
    assert.equal((await lstat(join(linked, '.git'))).isFile(), true)

    const installed = runInstaller(linked, envOverrides)
    assert.equal(installed.status, 0, installed.stderr)
    for (const hookName of ['pre-commit', 'commit-msg']) {
      const sourceHook = await readFile(join(linked, '.githooks', hookName), 'utf8')
      const installedPath = join(primary, '.git', 'hooks', hookName)
      assert.equal(await readFile(installedPath, 'utf8'), sourceHook)
      assert.notEqual((await lstat(installedPath)).mode & 0o111, 0)
    }
    assert.deepEqual(await hooksSnapshot(canary.hooksDirectory), externalBefore)
  } finally {
    let removal
    let prune
    if (registered) {
      removal = spawnGit(primary, ['worktree', 'remove', '--force', linked], envOverrides)
      prune = spawnGit(primary, ['worktree', 'prune', '--expire', 'now'], envOverrides)
    }
    await rm(container, { recursive: true, force: true })
    if (removal) assert.equal(removal.status, 0, removal.stderr)
    if (prune) assert.equal(prune.status, 0, prune.stderr)
  }
})
