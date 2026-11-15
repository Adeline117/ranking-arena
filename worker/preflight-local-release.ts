import { resolve } from 'node:path'
import { config } from 'dotenv'
import { mkdtemp, rm } from 'node:fs/promises'
import { assertWorkerEnvironmentFileLoaded } from './src/ingest/worker-environment-file'

const releaseDir = process.cwd()
const envFile = resolve(releaseDir, 'worker', '.env')
const browserDir = resolve(releaseDir, '.playwright-browsers')

// Deployment-provided values (especially the release-owned browser path) win
// over the secret file. The file supplies only the worker's runtime secrets.
const workerEnvironment = config({ path: envFile, override: false })

assertWorkerEnvironmentFileLoaded(workerEnvironment)

if (process.env.PLAYWRIGHT_BROWSERS_PATH !== browserDir) {
  throw new Error('[local-deploy-preflight] browser path is not release-owned')
}

const expectedWorkerNodeId = process.env.ARENA_EXPECTED_WORKER_NODE_ID
if (
  !expectedWorkerNodeId ||
  !process.env.WORKER_NODE_ID ||
  process.env.WORKER_NODE_ID !== expectedWorkerNodeId
) {
  throw new Error('[local-deploy-preflight] WORKER_NODE_ID must preserve the current logical node')
}
if (process.env.INGEST_LOCAL_REGION !== 'local') {
  throw new Error('[local-deploy-preflight] INGEST_LOCAL_REGION must be local')
}
const consumedRegions = (process.env.INGEST_REGIONS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
if (JSON.stringify(consumedRegions) !== JSON.stringify(['local'])) {
  throw new Error('[local-deploy-preflight] INGEST_REGIONS must be exactly local')
}

async function provePersistentBrowser(channel?: 'chrome'): Promise<void> {
  const { chromium } = await import('playwright')
  const profileDir = await mkdtemp(resolve(releaseDir, '.preflight-browser-'))
  try {
    const context = await withTimeout(
      chromium.launchPersistentContext(profileDir, {
        channel,
        headless: true,
      }),
      30_000,
      channel ? 'branded Chrome launch' : 'bundled Chromium launch'
    )
    await withTimeout(context.close(), 10_000, 'browser context close')
  } finally {
    await rm(profileDir, { force: true, recursive: true })
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function main(): Promise<void> {
  const [
    { assertMetricTrustWorkerReadiness },
    { assertPartitionedV4WorkerReadiness },
    { closeIngestPool },
  ] = await Promise.all([
    import('./src/ingest/metric-trust-readiness'),
    import('./src/ingest/attempt-bound-capture-readiness'),
    import('@/lib/ingest/db'),
  ])

  try {
    await assertMetricTrustWorkerReadiness()
    console.log('[local-deploy-preflight] metric-trust database release contract ready')
    await assertPartitionedV4WorkerReadiness()
    console.log('[local-deploy-preflight] partitioned V4 database release contract ready')
  } finally {
    await closeIngestPool().catch(() => undefined)
  }

  const [{ getConnection }] = await Promise.all([
    import('./src/connection'),
    import('@/lib/ingest/adapters/register'),
  ])
  const redis = getConnection()
  try {
    const pong = await withTimeout(redis.ping(), 8_000, 'Redis PING')
    if (pong !== 'PONG') throw new Error('[local-deploy-preflight] Redis PING is not exact')
    console.log('[local-deploy-preflight] Redis connection ready')
    await provePersistentBrowser()
    console.log('[local-deploy-preflight] release-owned Chromium profile launch ready')
    await provePersistentBrowser('chrome')
    console.log('[local-deploy-preflight] branded Chrome profile launch ready')
  } finally {
    redis.disconnect(false)
  }
}

main().catch(async (error) => {
  // A pooler certificate that does not chain to the configured CA must read
  // as a TLS trust failure, not as a generic database outage.
  const { describeIngestTlsFailure } = await import('@/lib/ingest/db')
  const tlsFailure = describeIngestTlsFailure(error)
  if (tlsFailure) console.error(`[local-deploy-preflight] ${tlsFailure}`)
  console.error(
    '[local-deploy-preflight] failed:',
    error instanceof Error ? error.message : String(error)
  )
  process.exit(1)
})
