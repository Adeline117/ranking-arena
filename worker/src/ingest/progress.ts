/**
 * Worker-side writers for the output watermarks (see
 * lib/ingest/worker-progress.ts). Best-effort: a Redis error is logged and
 * never fails the crawl or the scoring job it describes.
 */

import type IORedis from 'ioredis'
import { WORKER_PROGRESS_KEYS, type WorkerProgressKind } from '@/lib/ingest/worker-progress'

type ProgressRedis = Pick<IORedis, 'hset'>

async function write(redis: ProgressRedis, key: string, node: string, at: number): Promise<void> {
  try {
    await redis.hset(key, node, String(at))
  } catch (err) {
    console.error(
      `[worker-progress] could not record ${key} for ${node}:`,
      err instanceof Error ? err.message : err
    )
  }
}

export function markWorkerStarted(redis: ProgressRedis, node: string, now = Date.now()) {
  return write(redis, WORKER_PROGRESS_KEYS.started, node, now)
}

export function recordWorkerProgress(
  redis: ProgressRedis,
  kind: WorkerProgressKind,
  node: string,
  now = Date.now()
) {
  return write(redis, WORKER_PROGRESS_KEYS[kind], node, now)
}

/**
 * Tier-A hook: record a successful publication for THIS node. Fire-and-forget
 * so a slow/offline Redis can never delay or fail the crawl; dependencies are
 * resolved lazily so the processor keeps no new import-time side effects.
 */
export function noteTierAPublished(): void {
  void (async () => {
    try {
      const [{ getConnection }, { workerNodeId }] = await Promise.all([
        import('../connection'),
        import('./heartbeat'),
      ])
      await recordWorkerProgress(getConnection(), 'tier_a', workerNodeId())
    } catch (err) {
      console.error(
        '[worker-progress] tier_a watermark not recorded:',
        err instanceof Error ? err.message : err
      )
    }
  })()
}
