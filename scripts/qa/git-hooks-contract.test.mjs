import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('the repository-managed pre-commit hook is reproducible in clones and worktrees', async () => {
  const [packageJson, hook, installer, hookStat] = await Promise.all([
    source('package.json').then(JSON.parse),
    source('.githooks/pre-commit'),
    source('scripts/install-git-hooks.mjs'),
    stat(new URL('.githooks/pre-commit', root)),
  ])

  assert.equal(packageJson.scripts?.prepare, 'node scripts/install-git-hooks.mjs')
  assert.equal(packageJson.devDependencies?.['lint-staged'], '^16.4.0')
  assert.deepEqual(Object.keys(packageJson['lint-staged'] ?? {}).sort(), [
    '*.{js,jsx,mjs,cjs}',
    '*.{json,css,md}',
    '*.{ts,tsx}',
  ])
  assert.notEqual(hookStat.mode & 0o111, 0)
  assert.match(hook, /node_modules\/\.bin\/lint-staged --quiet/)
  assert.doesNotMatch(hook, /\bnpx\b/)
  assert.match(installer, /git[\s\S]*rev-parse[\s\S]*--git-path[\s\S]*hooks/)
  assert.match(installer, /copyFile\(source, destination\)/)
  assert.doesNotMatch(installer, /\.git\/hooks/)
})
