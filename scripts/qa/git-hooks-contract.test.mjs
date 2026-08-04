import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('repository-managed hooks are reproducible in clones and worktrees', async () => {
  const [packageJson, preCommit, commitMessage, installer, preCommitStat, commitMessageStat] =
    await Promise.all([
      source('package.json').then(JSON.parse),
      source('.githooks/pre-commit'),
      source('.githooks/commit-msg'),
      source('scripts/install-git-hooks.mjs'),
      stat(new URL('.githooks/pre-commit', root)),
      stat(new URL('.githooks/commit-msg', root)),
    ])

  assert.equal(packageJson.scripts?.prepare, 'node scripts/install-git-hooks.mjs')
  assert.equal(packageJson.devDependencies?.['lint-staged'], '^16.4.0')
  assert.deepEqual(Object.keys(packageJson['lint-staged'] ?? {}).sort(), [
    '*.{js,jsx,mjs,cjs}',
    '*.{json,css,md}',
    '*.{ts,tsx}',
  ])
  assert.notEqual(preCommitStat.mode & 0o111, 0)
  assert.notEqual(commitMessageStat.mode & 0o111, 0)
  assert.match(preCommit, /node_modules\/\.bin\/lint-staged --quiet/)
  assert.match(preCommit, /git diff --cached --diff-filter=A/)
  assert.match(preCommit, /\^\[0-9\]\{14\}_\[a-z0-9_\]\+/)
  assert.doesNotMatch(preCommit, /\bnpx\b/)
  assert.match(commitMessage, /\^debug:/)
  assert.match(commitMessage, /redeploy-trigger commits are not allowed/)
  assert.match(installer, /git[\s\S]*rev-parse[\s\S]*--git-path[\s\S]*hooks/)
  assert.match(installer, /\['pre-commit', 'commit-msg'\]/)
  assert.match(installer, /copyFile\(source, destination\)/)
  assert.doesNotMatch(installer, /\.git\/hooks/)

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
