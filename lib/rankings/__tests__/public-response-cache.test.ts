import {
  PUBLIC_RANKING_RESPONSE_CACHE_EPOCH,
  PUBLIC_RANKING_RESPONSE_CACHE_HEADER,
  PUBLIC_RANKING_RESPONSE_CACHE_PARAM,
  publicRankingResponseCacheHeaders,
  publicRankingResponseRejectionHeaders,
  redirectToPublicRankingResponseCacheEpoch,
} from '../public-response-cache'

describe('public ranking response cache epoch', () => {
  it('derives the response epoch from the ranking authority cache namespace', () => {
    expect(PUBLIC_RANKING_RESPONSE_CACHE_EPOCH).toBe('public-rank-policy-v7:public-response-v1')
  })

  it.each([
    'https://www.arenafi.org/api/og/exchange?exchange=binance_futures',
    'https://www.arenafi.org/api/og/exchange?exchange=binance_futures&_ranking_epoch=old',
  ])('redirects %s to a current URL-level cache key without caching the redirect', (url) => {
    const response = redirectToPublicRankingResponseCacheEpoch({ url })

    expect(response?.status).toBe(307)
    const location = new URL(response?.headers.get('Location') || '')
    expect(location.searchParams.get('exchange')).toBe('binance_futures')
    expect(location.searchParams.get(PUBLIC_RANKING_RESPONSE_CACHE_PARAM)).toBe(
      PUBLIC_RANKING_RESPONSE_CACHE_EPOCH
    )
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response?.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response?.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(response?.headers.get(PUBLIC_RANKING_RESPONSE_CACHE_HEADER)).toBe(
      PUBLIC_RANKING_RESPONSE_CACHE_EPOCH
    )
  })

  it('does not redirect the current versioned URL', () => {
    const url = new URL('https://www.arenafi.org/api/og/exchange?exchange=binance_futures')
    url.searchParams.set(PUBLIC_RANKING_RESPONSE_CACHE_PARAM, PUBLIC_RANKING_RESPONSE_CACHE_EPOCH)

    expect(redirectToPublicRankingResponseCacheEpoch({ url: url.toString() })).toBeNull()
  })

  it('marks current cacheable responses and source rejections with the epoch', () => {
    expect(publicRankingResponseCacheHeaders('public, s-maxage=60')).toEqual({
      'Cache-Control': 'public, s-maxage=60',
      [PUBLIC_RANKING_RESPONSE_CACHE_HEADER]: PUBLIC_RANKING_RESPONSE_CACHE_EPOCH,
    })
    expect(publicRankingResponseRejectionHeaders()).toEqual({
      'Cache-Control': 'private, no-store, max-age=0',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
      [PUBLIC_RANKING_RESPONSE_CACHE_HEADER]: PUBLIC_RANKING_RESPONSE_CACHE_EPOCH,
    })
  })
})
