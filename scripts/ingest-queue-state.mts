import { closeConnection } from '../worker/src/connection'
import {
  getFastQueue,
  getRegionQueue,
  INGEST_REGIONS,
  getTierCQueue,
} from '../worker/src/ingest/queues'

const COUNT_STATES = ['active', 'waiting', 'delayed', 'failed'] as const

async function main() {
  const queues = INGEST_REGIONS.flatMap((region) => [
    { label: region, queue: getRegionQueue(region) },
    { label: `fast/${region}`, queue: getFastQueue(region) },
    { label: `tierc/${region}`, queue: getTierCQueue(region) },
  ])

  try {
    for (const { label, queue } of queues) {
      console.log(`[${label}]`, await queue.getJobCounts(...COUNT_STATES))
    }
  } finally {
    await Promise.allSettled(queues.map(({ queue }) => queue.close()))
    await closeConnection()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
