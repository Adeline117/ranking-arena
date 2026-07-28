import { config } from 'dotenv'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function assertSgRuntimeEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.WORKER_NODE_ID !== 'vps_sg') {
    throw new Error('[sg-runtime-preflight] WORKER_NODE_ID must be exactly vps_sg')
  }
  if (env.INGEST_REGIONS !== 'vps_sg') {
    throw new Error('[sg-runtime-preflight] INGEST_REGIONS must be exactly vps_sg')
  }
  if (env.INGEST_LOCAL_REGION !== 'vps_sg') {
    throw new Error('[sg-runtime-preflight] INGEST_LOCAL_REGION must be exactly vps_sg')
  }
  if (env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED !== 'true') {
    throw new Error('[sg-runtime-preflight] attempt-bound capture must be enabled')
  }
}

function main(): void {
  config({ path: resolve(process.cwd(), 'worker', '.env'), override: false, quiet: true })
  assertSgRuntimeEnvironment(process.env)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : '[sg-runtime-preflight] failed')
    process.exit(1)
  }
}
