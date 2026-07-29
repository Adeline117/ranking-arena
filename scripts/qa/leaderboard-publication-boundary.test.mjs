import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()
const read = (path) => readFileSync(join(repoRoot, path), 'utf8')
const runtimeExtensions = new Set(['.cjs', '.js', '.mjs', '.mts', '.ts', '.tsx'])
const scanRoots = ['app', 'lib', 'worker/src', 'scripts']
const excludedDirectories = new Set(['__tests__', 'archive', 'node_modules', 'qa'])
const allowedRuntimeFiles = new Set(['scripts/maintenance/restore-from-r2.mjs'])

function extension(path) {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

function runtimeFiles(path) {
  const absolute = join(repoRoot, path)
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`
    if (entry.isDirectory()) {
      return excludedDirectories.has(entry.name) ? [] : runtimeFiles(child)
    }
    return entry.isFile() && runtimeExtensions.has(extension(entry.name)) ? [child] : []
  })
}

function directRankMutations() {
  const postgrestMutation =
    /\.from\s*\(\s*['"]leaderboard_ranks['"]\s*\)[\s\S]{0,600}?\.(?:insert|upsert|update|delete)\s*\(/
  const rawSqlMutation =
    /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?leaderboard_ranks"?\b/i

  return scanRoots
    .flatMap(runtimeFiles)
    .filter((path) => !allowedRuntimeFiles.has(path))
    .flatMap((path) => {
      const source = read(path)
      const violations = []
      if (postgrestMutation.test(source)) violations.push('PostgREST DML')
      if (rawSqlMutation.test(source)) violations.push('raw SQL DML')
      return violations.map((kind) => `${path}: ${kind}`)
    })
}

test('operator leaderboard trigger delegates to the canonical atomic publisher', () => {
  const script = read('scripts/compute-leaderboard-local.mjs')

  assert.match(script, /\/api\/cron\/compute-leaderboard/)
  assert.match(script, /Authorization: `Bearer \$\{cronSecret\}`/)
  assert.match(script, /CRON_SECRET is required/)
  assert.doesNotMatch(script, /createClient|SUPABASE_SERVICE_ROLE_KEY/)
  assert.doesNotMatch(script, /\.from\(['"]leaderboard_ranks['"]\)/)
})

test('daily source checkpoint cannot mutate the public leaderboard', () => {
  const script = read('scripts/daily-checkpoint.mjs')

  assert.match(script, /trader_sources/)
  assert.match(script, /trader_snapshots/)
  assert.doesNotMatch(script, /\.from\(['"]leaderboard_ranks['"]\)/)
})

test('active VPS recovery reaches leaderboard publication through the safe trigger', () => {
  const script = read('scripts/vps-health-check.mjs')

  assert.match(script, /scripts\/compute-leaderboard-local\.mjs/)
  assert.doesNotMatch(script, /\.from\(['"]leaderboard_ranks['"]\)/)
})

test('all runtime code keeps public rank mutations behind the canonical publisher', () => {
  assert.deepEqual(directRankMutations(), [])
})
