import { publicRankingCacheKey } from '@/lib/rankings/publication-policy'

/**
 * URL-level cache namespace for public images that contain ranking metrics.
 *
 * A response header alone cannot partition or purge a CDN cache. These routes
 * redirect unversioned/stale URLs to a URL carrying this epoch, so a ranking
 * authority rotation changes the actual CDN cache key.
 */
export const PUBLIC_RANKING_RESPONSE_CACHE_EPOCH = publicRankingCacheKey('public-response-v1')
export const PUBLIC_RANKING_RESPONSE_CACHE_PARAM = '_ranking_epoch'
export const PUBLIC_RANKING_RESPONSE_CACHE_HEADER = 'X-Arena-Ranking-Cache-Epoch'

const NO_STORE_REDIRECT_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/**
 * Redirect to the current policy URL before reading or rendering metrics.
 * The redirect itself must never be cached or it could pin callers to a prior
 * authority epoch after a future policy rotation.
 */
export function redirectToPublicRankingResponseCacheEpoch(
  request: Pick<Request, 'url'>
): Response | null {
  const url = new URL(request.url)
  if (
    url.searchParams.get(PUBLIC_RANKING_RESPONSE_CACHE_PARAM) ===
    PUBLIC_RANKING_RESPONSE_CACHE_EPOCH
  ) {
    return null
  }

  url.searchParams.set(PUBLIC_RANKING_RESPONSE_CACHE_PARAM, PUBLIC_RANKING_RESPONSE_CACHE_EPOCH)
  return new Response(null, {
    status: 307,
    headers: {
      ...NO_STORE_REDIRECT_HEADERS,
      Location: url.toString(),
      [PUBLIC_RANKING_RESPONSE_CACHE_HEADER]: PUBLIC_RANKING_RESPONSE_CACHE_EPOCH,
    },
  })
}

/** Attach the current epoch to cacheable image responses for observability. */
export function publicRankingResponseCacheHeaders(cacheControl: string): Record<string, string> {
  return {
    'Cache-Control': cacheControl,
    [PUBLIC_RANKING_RESPONSE_CACHE_HEADER]: PUBLIC_RANKING_RESPONSE_CACHE_EPOCH,
  }
}

/** Do not cache source-policy rejections under either an old or current epoch. */
export function publicRankingResponseRejectionHeaders(): Record<string, string> {
  return {
    ...NO_STORE_REDIRECT_HEADERS,
    [PUBLIC_RANKING_RESPONSE_CACHE_HEADER]: PUBLIC_RANKING_RESPONSE_CACHE_EPOCH,
  }
}
