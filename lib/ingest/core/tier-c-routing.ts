import type { IngestRegion } from './regions'
import { isIngestRegion } from './regions'

/**
 * Keep the historical queue name as the local queue. That preserves all
 * waiting/delayed jobs created before regional Tier-C queues existed, while
 * remote regions get isolated consumers.
 */
export const LEGACY_TIER_C_QUEUE_NAME = 'arena-ingest-tierc'

export function tierCQueueName(region: unknown): string {
  if (!isIngestRegion(region)) {
    throw new Error(`[tier-c] unsupported fetch region: ${String(region)}`)
  }
  return region === 'local' ? LEGACY_TIER_C_QUEUE_NAME : `${LEGACY_TIER_C_QUEUE_NAME}-${region}`
}

export function assertIngestRegion(value: unknown): IngestRegion {
  if (!isIngestRegion(value)) {
    throw new Error(`[tier-c] unsupported fetch region: ${String(value)}`)
  }
  return value
}
