import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
  COPIER_SNAPSHOT_RECORDS_CONTRACT,
  COPIER_SNAPSHOT_SOURCE_AUTHORITY_CONTRACT,
  METRIC_AUTHORITY_NO_STORE_HEADERS,
  SERVING_METRIC_AUTHORITY_CACHE_EPOCH,
  servingMetricAuthorityCacheKey,
} from '../cache-policy'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('serving metric authority cache boundary', () => {
  it('uses a dedicated cache epoch and strict surrogate no-store headers', () => {
    expect(SERVING_METRIC_AUTHORITY_CACHE_EPOCH).toBe('serving-metric-authority-v2')
    expect(servingMetricAuthorityCacheKey('arena-source-capabilities')).toBe(
      'serving-metric-authority-v2:arena-source-capabilities'
    )
    expect(COPIER_SNAPSHOT_RECORDS_CONTRACT).toBe('csr2')
    expect(COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT).toBe('arena.copier-snapshot-receipt-reader@4')
    expect(COPIER_SNAPSHOT_SOURCE_AUTHORITY_CONTRACT).toBe(
      'arena.copier-snapshot-source-authority@1'
    )
    expect(METRIC_AUTHORITY_NO_STORE_HEADERS).toEqual({
      'Cache-Control': 'private, no-store, max-age=0',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
    })
  })

  it.each([
    'app/api/traders/[handle]/first-screen/route.ts',
    'app/api/traders/[handle]/core/route.ts',
    'app/api/sources/capabilities/route.ts',
  ])('%s never publishes metric payloads through SWR', (path) => {
    const route = source(path)
    expect(route).toContain('METRIC_AUTHORITY_NO_STORE_HEADERS')
    expect(route).not.toContain('staleWhileRevalidate:')
    expect(route).not.toContain('stale-while-revalidate=')
  })

  it.each([
    'app/api/traders/[handle]/first-screen/route.ts',
    'app/api/sources/capabilities/route.ts',
  ])('%s reads capabilities without a persistent server cache', (path) => {
    const route = source(path)
    expect(route).toContain('getSourceCapabilities(supabase)')
    expect(route).not.toContain('unstable_cache')
    expect(route).not.toContain('getReadReplica')
  })

  it('epochs the trader-page capability seed and limits it to 30 seconds', () => {
    const page = source('app/(app)/trader/[handle]/page.tsx')
    expect(page).toContain("servingMetricAuthorityCacheKey('arena-source-capabilities')")
    expect(page).toMatch(
      /servingMetricAuthorityCacheKey\('arena-source-capabilities'\)[\s\S]*revalidate: 30/
    )
  })
})
