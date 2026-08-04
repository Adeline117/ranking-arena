import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

test('documentation index contains only resolvable local links', () => {
  const indexPath = resolve(root, 'docs/README.md')
  const markdown = readFileSync(indexPath, 'utf8')
  const links = [
    ...markdown.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#?]+)(?:#[^)]+)?\)/g),
  ].map((match) => match[1].replace(/^<|>$/g, ''))

  assert.ok(links.length > 0, 'docs/README.md must index local documentation')
  for (const link of links) {
    assert.ok(
      existsSync(resolve(dirname(indexPath), decodeURIComponent(link))),
      `missing docs index target: ${link}`
    )
  }
})

test('concrete CODEOWNERS paths exist', () => {
  const entries = read('.github/CODEOWNERS')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0])
    .filter((pattern) => pattern.startsWith('/') && !/[?*[]/.test(pattern))

  for (const entry of entries) {
    assert.ok(existsSync(resolve(root, `.${entry}`)), `stale concrete CODEOWNERS path: ${entry}`)
  }
})

test('runbook does not restore retired or fictional recovery controls', () => {
  const runbook = read('docs/RUNBOOK.md')
  assert.doesNotMatch(runbook, /scripts\/pipeline-report\.ts/)
  assert.doesNotMatch(runbook, /FEATURE_READ_ONLY/)
  assert.doesNotMatch(runbook, /Redis is non-critical|all Redis consumers fail-open/i)
})

test('source policies scan the owned repository boundary in clean CI checkouts', () => {
  const packageJson = JSON.parse(read('package.json'))
  const workflow = read('.github/workflows/ci.yml')
  const policy = read('scripts/qa/source-policy-check.mjs')

  assert.equal(packageJson.scripts.lint, 'eslint .')
  assert.equal(packageJson.scripts['qa:source-policy'], 'node scripts/qa/source-policy-check.mjs')
  assert.match(workflow, /run: npm run qa:source-policy/)
  assert.match(policy, /git\(\['ls-files', '-co', '--exclude-standard'/)
  assert.doesNotMatch(policy, /git\(\['diff'/)
})

test('session worktrees isolate credentials, dependencies, and destructive cleanup', () => {
  const scriptPath = resolve(root, 'scripts/new-session-worktree.sh')
  const script = read('scripts/new-session-worktree.sh')

  assert.notEqual(
    statSync(scriptPath).mode & 0o111,
    0,
    'session worktree helper must be executable'
  )
  assert.match(script, /validate_name/)
  assert.match(script, /git worktree remove "\$WT_BASE\/\$NAME"/)
  assert.match(script, /git branch -d "session\/\$NAME"/)
  assert.match(script, /gh pr create --base main --head \$BRANCH/)
  assert.match(script, /nvm use && npm ci/)
  assert.doesNotMatch(script, /ln -s/)
  assert.doesNotMatch(script, /git worktree remove[^\n]*--force/)
  assert.doesNotMatch(script, /git branch -D/)
})
