/** Serverless-safe bridge for an immediate first-party sync on the ingest worker. */

import type { ConnectionOptions, Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { logger } from '@/lib/logger'

const QUEUE_NAME = 'arena-ingest'
const JOB_NAME = 'firstparty:sync'

let bridge: { queue: Queue; redis: Redis } | null = null

async function getBridge(): Promise<{ queue: Queue; redis: Redis } | null> {
  if (bridge) return bridge
  const url = process.env.REDIS_URL
  if (!url) return null
  try {
    const [{ Queue: BullQueue }, { default: IORedis }] = await Promise.all([
      import('bullmq'),
      import('ioredis'),
    ])
    const redis = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: url.startsWith('rediss://') ? {} : undefined,
    })
    redis.on('error', (error) => logger.error('[first-party-enqueue] redis error:', error.message))
    const queue = new BullQueue(QUEUE_NAME, {
      connection: redis as unknown as ConnectionOptions,
    })
    bridge = { queue, redis }
    return bridge
  } catch (error) {
    logger.error(
      '[first-party-enqueue] bridge init failed:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}

export async function enqueueFirstPartySync(authorizationId: string): Promise<boolean> {
  if (!authorizationId) return false
  try {
    const activeBridge = await getBridge()
    if (!activeBridge) return false
    await activeBridge.queue.add(
      JOB_NAME,
      { authorizationId },
      {
        jobId: `fp-initial-${authorizationId}`,
        priority: 4,
        removeOnComplete: true,
        removeOnFail: { age: 300 },
      }
    )
    return true
  } catch (error) {
    logger.error(
      '[first-party-enqueue] enqueue failed:',
      error instanceof Error ? error.message : error
    )
    return false
  }
}
