import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function readSource(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

const gate = readSource('lib/cron/v1-ranking-command-chain-publication.ts')
const workerEntry = readSource('worker/src/index.ts')
const scheduler = readSource('worker/src/scheduler.ts')
const triggerChain = readSource('lib/cron/trigger-chain.ts')
const packageJson = JSON.parse(readSource('package.json'))

test('V1 ranking command-chain gate is a checked-in constant with no environment override', () => {
  assert.match(gate, /V1_RANKING_COMMAND_CHAIN_PUBLISHED\s*=\s*true\s+as const/)
  assert.match(gate, /isV1RankingCommandChainPublished\(\): boolean/)
  assert.doesNotMatch(gate, /process\.env|NEXT_PUBLIC_|RANKING_COMMAND_CHAIN.*(?:ENV|FLAG)/)
})

test('worker entry checks the gate before dotenv, BullMQ, DB, Redis, or HTTP dependencies load', () => {
  const gateCheck = workerEntry.indexOf('if (!isV1RankingCommandChainPublished())')
  const firstDeferredImport = workerEntry.indexOf("import('node:path')")

  assert.ok(gateCheck >= 0)
  assert.ok(firstDeferredImport > gateCheck)
  // Type-only imports are erased at runtime and load nothing.
  assert.doesNotMatch(
    workerEntry,
    /^import\s+(?!type\s)(?!\{ isV1RankingCommandChainPublished \})/m
  )
  assert.doesNotMatch(
    workerEntry.slice(0, gateCheck),
    /config\(|new Worker\(|fetch\(|getConnection\(|getQueue\(/
  )
  assert.match(
    workerEntry.slice(gateCheck, firstDeferredImport),
    /V1 ranking command chain is not published; worker will not start\./
  )
  assert.match(workerEntry.slice(gateCheck, firstDeferredImport), /process\.exitCode\s*=\s*2/)
})

test('the npm worker entrypoint does not preload worker dotenv configuration', () => {
  assert.equal(packageJson.scripts.worker, 'tsx worker/src/index.ts')
  assert.doesNotMatch(packageJson.scripts.worker, /dotenv|worker\/.env/)
})

test('scheduler returns before resolving or mutating a BullMQ scheduler', () => {
  const gateCheck = scheduler.indexOf('if (!isV1RankingCommandChainPublished())')
  const queueImport = scheduler.indexOf("import('./queues')")

  assert.ok(gateCheck >= 0)
  assert.ok(queueImport > gateCheck)
  assert.match(scheduler.slice(gateCheck, queueImport), /schedules remain untouched\.|return/)
  assert.doesNotMatch(
    scheduler.slice(0, gateCheck),
    /getQueue\(|getJobSchedulers\(|removeJobScheduler\(|upsertJobScheduler\(/
  )
})

test('downstream refresh returns before Redis import or background fetch work', () => {
  const triggerStart = triggerChain.indexOf('export function triggerDownstreamRefresh')
  const gateCheck = triggerChain.indexOf('if (!isV1RankingCommandChainPublished())', triggerStart)
  const backgroundLaunch = triggerChain.indexOf('void (async () => {', gateCheck)
  const redisImport = triggerChain.indexOf("import('@/lib/cache/redis-client')", gateCheck)

  assert.ok(triggerStart >= 0)
  assert.ok(gateCheck > triggerStart)
  assert.ok(backgroundLaunch > gateCheck)
  assert.ok(redisImport > backgroundLaunch)
  assert.match(
    triggerChain.slice(gateCheck, backgroundLaunch),
    /refresh was not triggered\.|return/
  )
})
