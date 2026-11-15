import { config } from 'dotenv'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertWorkerEnvironmentFileLoaded } from './src/ingest/worker-environment-file'

export function assertSgRuntimeEnvironment(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (env.WORKER_NODE_ID !== 'vps_sg') {
    throw new Error('[sg-runtime-preflight] WORKER_NODE_ID must be exactly vps_sg')
  }
  if (env.INGEST_REGIONS !== 'vps_sg') {
    throw new Error('[sg-runtime-preflight] INGEST_REGIONS must be exactly vps_sg')
  }
  if (env.INGEST_LOCAL_REGION !== 'vps_sg') {
    throw new Error('[sg-runtime-preflight] INGEST_LOCAL_REGION must be exactly vps_sg')
  }
}

export function assertSgRuntimeEnvironmentFile(parsed: Record<string, string> | undefined): void {
  if (parsed === undefined) {
    throw new Error('[sg-runtime-preflight] worker/.env could not be parsed')
  }
  assertSgRuntimeEnvironment(parsed)
}

async function main(): Promise<void> {
  const loaded = config({
    path: resolve(process.cwd(), 'worker', '.env'),
    override: false,
    quiet: true,
  })
  assertWorkerEnvironmentFileLoaded(loaded)
  assertSgRuntimeEnvironmentFile(loaded.parsed)
  assertSgRuntimeEnvironment(process.env)

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
    await assertPartitionedV4WorkerReadiness()
  } finally {
    await closeIngestPool().catch(() => undefined)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  void main().catch(async (error) => {
    const { describeIngestTlsFailure } = await import('@/lib/ingest/db')
    const tlsFailure = describeIngestTlsFailure(error)
    if (tlsFailure) console.error(`[sg-runtime-preflight] ${tlsFailure}`)
    console.error(error instanceof Error ? error.message : '[sg-runtime-preflight] failed')
    process.exit(1)
  })
}
