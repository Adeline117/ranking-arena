import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function readSource(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

const processor = readSource('worker/src/ingest/processors/avatar-mirror.ts')
const scheduler = readSource('worker/src/ingest/scheduler.ts')
const jobNames = readSource('worker/src/ingest/job-names.ts')
const ingestWorker = readSource('worker/src/ingest-worker.ts')

test('avatar-mirror processor is a dependency-free compatibility no-op', () => {
  assert.deepEqual(processor.match(/^import .*$/gm), ["import type { Job } from 'bullmq'"])
  assert.match(processor, /export\s+async\s+function\s+processAvatarMirror\s*\(/)
  assert.match(processor, /return\s+\{\s*mirrored:\s*0,\s*failed:\s*0\s*\}/)

  for (const forbidden of [
    /process\.env/,
    /\bfetch\s*\(/i,
    /supabase/i,
    /storage/i,
    /\bdatabase\b/i,
    /\bdb\b/i,
    /\bsql\b/i,
    /avatar_url_mirror/i,
    /createClient\s*\(/,
    /getIngestPool\s*\(/,
    /\.query\s*\(/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
  ]) {
    assert.doesNotMatch(processor, forbidden)
  }
})

test('avatar-mirror is retained only as a legacy identity, not a scheduler producer', () => {
  assert.match(jobNames, /AVATAR_MIRROR:\s*['"]maint:avatar-mirror['"]/)
  assert.match(jobNames, /Retired V1 legacy queue identity/)
  assert.doesNotMatch(scheduler, /AVATAR_MIRROR|maint:avatar-mirror/)
})

test('ingest worker discards avatar-mirror before its route() source lease or processor loading', () => {
  const routeStart = ingestWorker.indexOf('async function route(')
  const routeEnd = ingestWorker.indexOf('async function routeTierC(', routeStart)
  const routeSource = ingestWorker.slice(routeStart, routeEnd)
  const avatarBranch = routeSource.indexOf('if (job.name === INGEST_JOB.AVATAR_MIRROR)')
  const leaseRoute = routeSource.indexOf('return routeJobWithSourceLease({')
  const redisLease = routeSource.indexOf('redis: getConnection(),')

  assert.ok(routeStart >= 0)
  assert.ok(routeEnd > routeStart)
  assert.ok(avatarBranch >= 0)
  assert.ok(leaseRoute > avatarBranch)
  assert.ok(redisLease > avatarBranch)
  assert.match(routeSource.slice(avatarBranch, leaseRoute), /mirrored:\s*0,\s*failed:\s*0/)
  assert.doesNotMatch(ingestWorker, /processors\/avatar-mirror/)

  const runJobStart = ingestWorker.indexOf('async function runJob(')
  const runJobEnd = ingestWorker.indexOf('async function route(', runJobStart)
  const runJobSource = ingestWorker.slice(runJobStart, runJobEnd)
  const avatarCase = runJobSource.indexOf('case INGEST_JOB.AVATAR_MIRROR:')
  const nextCase = runJobSource.indexOf('case INGEST_JOB.MAINTENANCE:', avatarCase)

  assert.ok(avatarCase >= 0)
  assert.ok(nextCase > avatarCase)
  assert.match(runJobSource.slice(avatarCase, nextCase), /mirrored:\s*0,\s*failed:\s*0/)
  assert.doesNotMatch(runJobSource.slice(avatarCase, nextCase), /import\s*\(/)
})
