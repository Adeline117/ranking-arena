/**
 * Cache boundary for serving responses whose metric authority can change.
 *
 * Bump this epoch whenever a migration changes which rows or metrics may be
 * published. Reusing an older Next data-cache namespace can otherwise keep a
 * withdrawn metric public after the database has already quarantined it.
 */
export const SERVING_METRIC_AUTHORITY_CACHE_EPOCH = 'serving-metric-authority-v2'

/**
 * Browser/API generation for copier aggregates. A caller that does not send
 * this exact marker may still have a cache entry created before the immutable
 * source-authority registry existed, so the route rejects it before resolving
 * a trader or invoking either serving RPC.
 */
export const COPIER_SNAPSHOT_RECORDS_CONTRACT = 'csr2' as const

/** Exact database markers emitted by the source-authority cutover RPCs. */
export const COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT =
  'arena.copier-snapshot-receipt-reader@4' as const
export const COPIER_SNAPSHOT_SOURCE_AUTHORITY_CONTRACT =
  'arena.copier-snapshot-source-authority@1' as const

export function servingMetricAuthorityCacheKey(key: string): string {
  return `${SERVING_METRIC_AUTHORITY_CACHE_EPOCH}:${key}`
}

/**
 * Profile metric responses are cheap enough to re-read and too sensitive to
 * serve through a stale edge entry during an authority cutover. The surrogate
 * cache headers are explicit because some CDNs prioritize them over the
 * browser-facing Cache-Control header.
 */
export const METRIC_AUTHORITY_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const
