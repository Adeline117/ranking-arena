import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()
const read = (path) => readFileSync(join(repoRoot, path), 'utf8')

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
