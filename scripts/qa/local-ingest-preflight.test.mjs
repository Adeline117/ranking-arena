import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync('worker/preflight-local-release.ts', 'utf8')

test('local preflight preserves one explicit logical-node and region contract', () => {
  assert.match(source, /config\(\{ path: envFile, override: false \}\)/)
  assert.match(source, /process\.env\.WORKER_NODE_ID !== expectedWorkerNodeId/)
  assert.match(source, /INGEST_LOCAL_REGION !== 'local'/)
  assert.match(source, /INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED !== 'true'/)
  assert.match(source, /JSON\.stringify\(\['local'\]\)/)
  assert.doesNotMatch(source, /\.sort\(\)/)
})

test('database gate and both real persistent-browser paths run before success', () => {
  const databaseGate = source.indexOf('await assertMetricTrustWorkerReadiness()')
  const partitionedV4Gate = source.indexOf('await assertPartitionedV4WorkerReadiness()')
  const bundledBrowser = source.indexOf('await provePersistentBrowser()')
  const brandedBrowser = source.indexOf("await provePersistentBrowser('chrome')")
  const closePool = source.indexOf('await closeIngestPool()')

  assert.ok(databaseGate >= 0)
  assert.ok(databaseGate < partitionedV4Gate)
  assert.ok(partitionedV4Gate < closePool)
  assert.ok(closePool < bundledBrowser)
  assert.ok(bundledBrowser < brandedBrowser)
  assert.match(source, /chromium\.launchPersistentContext/)
  assert.match(source, /\.preflight-browser-/)
})

test('browser and database resources are closed even when a preflight fails', () => {
  assert.match(source, /finally \{[\s\S]*closeIngestPool\(\)\.catch/)
  assert.match(source, /finally \{[\s\S]*rm\(profileDir, \{ force: true, recursive: true \}\)/)
})

test('loads adapter registrations and proves bounded Redis connectivity', () => {
  assert.match(source, /import\('@\/lib\/ingest\/adapters\/register'\)/)
  assert.match(source, /withTimeout\(redis\.ping\(\), 8_000, 'Redis PING'\)/)
  assert.match(source, /pong !== 'PONG'/)
  assert.match(source, /finally \{[\s\S]*redis\.disconnect\(false\)/)
})
