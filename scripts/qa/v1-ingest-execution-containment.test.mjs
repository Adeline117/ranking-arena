import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function readSource(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

const gate = readSource('lib/ingest/v1-execution-publication.ts')
const ingestWorker = readSource('worker/src/ingest-worker.ts')
const connection = readSource('worker/src/connection.ts')
const scheduler = readSource('worker/src/ingest/scheduler.ts')
const tierC = readSource('lib/data/serving/tier-c.ts')
const firstParty = readSource('lib/ingest/first-party/enqueue.ts')
const onchainRoute = readSource('app/api/trader/onchain-enrich/route.ts')
const onchainTrigger = readSource('app/(app)/trader/[handle]/hooks/useOnchainEnrichTrigger.ts')
const servingReadiness = readSource('scripts/qa/serving-page-readiness.mjs')
const servingContract = readSource('scripts/qa/serving-data-contract.test.mjs')
const servingProfileE2e = readSource('scripts/qa/serving-profiles-e2e.mjs')

test('V1 ingest execution gate is fixed false and cannot be reopened from an environment', () => {
  assert.match(gate, /V1_INGEST_EXECUTION_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(gate, /isV1IngestExecutionPublished\(\): boolean/)
  assert.match(gate, /INGEST_EXECUTION_NOT_PUBLISHED/)
  assert.doesNotMatch(gate, /process\.env|NEXT_PUBLIC_|INGEST_EXECUTION.*(?:ENV|FLAG)/)
})

test('ingest worker exits before dotenv and runtime dependency loading', () => {
  const gateCheck = ingestWorker.indexOf('if (!isV1IngestExecutionPublished())')
  const firstDeferredImport = ingestWorker.indexOf("import('node:path')")

  assert.ok(gateCheck >= 0)
  assert.ok(firstDeferredImport > gateCheck)
  assert.doesNotMatch(
    ingestWorker,
    /^import\s+(?!type\b)(?!\{\s*isV1IngestExecutionPublished\s*\})/m
  )
  assert.doesNotMatch(
    ingestWorker.slice(0, gateCheck),
    /config\(|process\.env|getConnection\(|new Worker\(|fetch\(/
  )
  assert.match(
    ingestWorker.slice(gateCheck, firstDeferredImport),
    /V1 ingest execution is not published; worker will not start\./
  )
  assert.match(ingestWorker.slice(gateCheck, firstDeferredImport), /process\.exitCode\s*=\s*2/)
})

test('connection gate precedes ioredis loading, construction, and shutdown traffic', () => {
  const getConnectionStart = connection.indexOf('export function getConnection')
  const publicationAssert = connection.indexOf(
    'assertV1IngestExecutionPublished()',
    getConnectionStart
  )
  const loadCall = connection.indexOf('const IORedis = loadIORedis()', getConnectionStart)
  const construction = connection.indexOf('new IORedis(', getConnectionStart)
  const closeStart = connection.indexOf('export async function closeConnection')
  const closeGate = connection.indexOf('if (!isV1IngestExecutionPublished()) return', closeStart)
  const quit = connection.indexOf('connection.quit()', closeStart)

  assert.ok(publicationAssert > getConnectionStart)
  assert.ok(loadCall > publicationAssert)
  assert.ok(construction > publicationAssert)
  assert.ok(closeGate > closeStart)
  assert.ok(quit > closeGate)
  assert.doesNotMatch(connection, /^import\s+[^t][^\n]*from\s+['"]ioredis['"]/m)
})

test('scheduler paths gate before deferred DB, Redis, and BullMQ runtime loading', () => {
  const schedulerGate = scheduler.indexOf('if (!isV1IngestExecutionPublished())')
  const schedulerLoad = scheduler.indexOf('await loadSchedulerRuntime()', schedulerGate)
  const sourceRead = scheduler.indexOf('const sources = await getActiveSources()', schedulerGate)
  const servingStart = scheduler.indexOf('export async function reconcileServingSources')
  const servingGate = scheduler.indexOf('if (!isV1IngestExecutionPublished())', servingStart)
  const servingLoad = scheduler.indexOf('await loadSchedulerRuntime()', servingGate)
  const servingRead = scheduler.indexOf('const names = await getServingSourceNames()', servingGate)

  assert.ok(schedulerGate >= 0)
  assert.ok(schedulerLoad > schedulerGate)
  assert.ok(sourceRead > schedulerLoad)
  assert.ok(servingGate > servingStart)
  assert.ok(servingLoad > servingGate)
  assert.ok(servingRead > servingLoad)
  assert.doesNotMatch(scheduler, /^import\s+(?!\{\s*isV1IngestExecutionPublished\s*\})/m)
})

test('web-to-worker Tier-C and first-party admission return before bridge construction', () => {
  const tierCStart = tierC.indexOf('export async function requestTierCWithProvider')
  const tierCGate = tierC.indexOf('if (!isV1IngestExecutionPublished()) return null', tierCStart)
  const tierCBridge = tierC.indexOf('const b = await bridgeProvider', tierCStart)
  const firstPartyStart = firstParty.indexOf('export async function enqueueFirstPartySync')
  const firstPartyGate = firstParty.indexOf(
    'if (!isV1IngestExecutionPublished()) return false',
    firstPartyStart
  )
  const firstPartyBridge = firstParty.indexOf(
    'const activeBridge = await getBridge()',
    firstPartyStart
  )

  assert.ok(tierCGate > tierCStart)
  assert.ok(tierCBridge > tierCGate)
  assert.ok(firstPartyGate > firstPartyStart)
  assert.ok(firstPartyBridge > firstPartyGate)
})

test('on-chain request and browser trigger hold before any provider request', () => {
  const effectGate = onchainTrigger.indexOf('if (v1ExecutionUnavailable) return')
  const request = onchainTrigger.indexOf("fetch('/api/trader/onchain-enrich'")

  assert.match(onchainRoute, /INGEST_EXECUTION_NOT_PUBLISHED/)
  assert.match(onchainRoute, /status:\s*410/)
  assert.match(onchainRoute, /Vercel-CDN-Cache-Control/)
  assert.doesNotMatch(
    onchainRoute,
    /getSupabaseAdmin|enrichWeb3Wallet|checkRateLimit|\.rpc\(|req\.json\(|fetch\(/
  )
  assert.ok(effectGate >= 0)
  assert.ok(request > effectGate)
  assert.match(onchainTrigger, /return v1ExecutionUnavailable \? 'unavailable' : state/)
})

test('serving QA no longer treats on-chain 503 responses as an optional exception', () => {
  assert.doesNotMatch(
    servingReadiness,
    /isOptionalOnchainDegradation|isOptionalResourceConsoleError/
  )
  assert.match(
    servingContract,
    /assert\.doesNotMatch\(profileRender, \/isOptionalOnchainDegradation\//
  )
  assert.doesNotMatch(
    servingProfileE2e,
    /isOptionalOnchainDegradation|optionalHttp|status\(\) === 503/
  )
})

const DIRECT_EXECUTION_TOMBSTONES = [
  'scripts/ingest-enqueue-region-smoke.mts',
  'scripts/ingest-test-surfaces.ts',
  'scripts/onchain-enrich-web3.mts',
  'scripts/archive/test-onchain-apis.mjs',
  'scripts/ingest-capture-xhr.mts',
  'worker/find-wedged-schedulers.mjs',
  'worker/kick-wedged-source.mjs',
]

test('direct ingest execution commands are inert V1 exit-2 tombstones', () => {
  for (const path of DIRECT_EXECUTION_TOMBSTONES) {
    const source = readSource(path)
    assert.match(source, /\[RETIRED\]/, path)
    assert.match(source, /process\.exitCode\s*=\s*2/, path)
    assert.doesNotMatch(
      source,
      /\bimport\b|\brequire\(|process\.env|dotenv|fetch\(|https?:\/\/|new Queue|new IORedis|\.query\(|\.add\(|\.update\(|\.insert\(|\.delete\(/,
      path
    )

    const result = spawnSync(process.execPath, [resolve(ROOT, path), '--ignored'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    })
    assert.equal(result.error, undefined, path)
    assert.equal(result.status, 2, path)
    assert.equal(result.stdout, '', path)
    assert.match(result.stderr, /\[RETIRED\]/, path)
  }
})

test('directly executable V1 tombstones exit 2 without starting a runtime', () => {
  for (const path of ['worker/find-wedged-schedulers.mjs', 'worker/kick-wedged-source.mjs']) {
    const result = spawnSync(process.execPath, [path], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.status, 2, path)
    assert.match(`${result.stdout}${result.stderr}`, /\[RETIRED\]/, path)
  }
})

test('the retired archive on-chain probe is documented without legacy run or upload instructions', () => {
  const progress = readSource('docs/PROGRESS.md')
  const runbook = readSource('docs/RUNBOOK.md')
  const onchainReadme = readSource('scripts/ONCHAIN_ENRICHMENT_README.md')
  const deployReadme = readSource('scripts/DEPLOY_TO_VPS.md')

  for (const document of [progress, runbook]) {
    assert.match(document, /V1 archive on-chain probe source (?:containment|boundary)/)
    assert.match(document, /`scripts\/archive\/test-onchain-apis\.mjs`/)
    assert.match(document, /source-only/)
  }

  for (const document of [onchainReadme, deployReadme]) {
    assert.match(document, /scripts\/archive\/test-onchain-apis\.mjs/)
    assert.doesNotMatch(document, /node scripts\/test-onchain-apis\.mjs/)
    assert.doesNotMatch(document, /scp ~\/arena\/scripts\/test-onchain-apis\.mjs/)
  }
})
