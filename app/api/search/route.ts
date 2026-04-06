/**
 * Unified Search API
 * Searches traders, posts, library, users by category with fuzzy matching.
 *
 * GET /api/search?q=xxx             - Unified search
 * GET /api/search?q=xxx&platform=binance_futures - Filter by exchange
 * GET /api/search?type=trending     - Trending searches
 * GET /api/search?type=hot          - Hot searches
 * GET /api/search?type=click&q=x&id=x&rtype=trader - Track click-through
 *
 * Features:
 * - Fuzzy matching via pg_trgm (catches typos like "binane" -> "binance")
 * - Weighted scoring: exact > prefix > contains > fuzzy
 * - Exchange name search: "binance" matches all Binance traders
 * - Stats-based search: "ROI > 100" or "top bybit traders"
 * - "Did you mean" suggestions for low-result queries
 */

import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'
import { fireAndForget } from '@/lib/utils/logger'
import { features } from '@/lib/features'
import { searchTraders as unifiedSearchTraders, getSearchSuggestions } from '@/lib/data/unified'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { searchTradersMeili, isMeilisearchAvailable } from '@/lib/search/meilisearch'

// Removed force-dynamic: search results are cacheable via Redis + HTTP cache headers
// Previous force-dynamic blocked Vercel CDN caching entirely

export interface UnifiedSearchResult {
  id: string
  type: 'trader' | 'post' | 'library' | 'user' | 'group'
  title: string
  subtitle?: string
  href: string
  avatar?: string | null
  meta?: Record<string, unknown>
}

export interface UnifiedSearchResponse {
  query: string
  results: {
    traders: UnifiedSearchResult[]
    posts: UnifiedSearchResult[]
    library: UnifiedSearchResult[]
    users: UnifiedSearchResult[]
    groups: UnifiedSearchResult[]
  }
  total: number
  /** "Did you mean" suggestions when few results found */
  suggestions?: string[]
  /** Matched exchange platform filter (when query matches an exchange name) */
  matchedExchange?: string
  /** Facet distribution from Meilisearch (platform counts, trader_type counts, etc.) */
  facetDistribution?: Record<string, Record<string, number>>
}

// ---------- Exchange name matcher ----------

function matchExchangeName(query: string): string | null {
  const q = query.toLowerCase().trim()
  for (const [platform, config] of Object.entries(EXCHANGE_CONFIG)) {
    if (config.name.toLowerCase() === q) return platform
    if (config.name.toLowerCase().replace(/[.\s]/g, '') === q.replace(/[.\s]/g, '')) return platform
  }
  const aliases: Record<string, string> = {
    binance: 'binance_futures',
    bybit: 'bybit',
    okx: 'okx_futures',
    bitget: 'bitget_futures',
    mexc: 'mexc',
    htx: 'htx_futures',
    huobi: 'htx_futures',
    gate: 'gateio',
    'gate.io': 'gateio',
    coinex: 'coinex',
    hyperliquid: 'hyperliquid',
    hl: 'hyperliquid',
    gmx: 'gmx',
    dydx: 'dydx',
    drift: 'drift',
    etoro: 'etoro',
  }
  return aliases[q] || null
}

// ---------- Stats-based search parser ----------

interface StatsFilter {
  platform?: string
  minRoi?: number
  sortBy?: 'roi' | 'pnl' | 'arena_score'
}

function parseStatsQuery(query: string): StatsFilter | null {
  const q = query.toLowerCase().trim()
  const roiMatch = q.match(/roi\s*[>]\s*(\d+)/)
  if (roiMatch) {
    return { minRoi: parseFloat(roiMatch[1]) }
  }
  const topMatch = q.match(/^(?:top|best)\s+(\w+)(?:\s+traders?)?$/i)
  if (topMatch) {
    const exchangeKey = matchExchangeName(topMatch[1])
    if (exchangeKey) {
      return { platform: exchangeKey, sortBy: 'arena_score' }
    }
  }
  return null
}

// ---------- Trending searches ----------

interface TrendingSearchItem {
  query: string
  searchCount: number
  rank: number
  category?: 'trader' | 'token' | 'general'
}

interface TrendingSearchResponse {
  trending: TrendingSearchItem[]
  fallback: string[]
  lastUpdated: string
}

async function handleTrendingSearch(supabase: Parameters<Parameters<typeof withPublic>[0]>[0]['supabase']) {
  const cacheKey = 'search:trending:queries'

  try {
    const cached = await cacheGet<TrendingSearchResponse>(cacheKey)
    if (cached) {
      return success(cached)
    }
  } catch {
    // Intentionally swallowed: Redis cache miss or unavailable, fall through to DB query
  }

  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { data: analyticsData, error } = await supabase
    .from('search_analytics')
    .select('query, result_count, created_at')
    .gte('created_at', sevenDaysAgo.toISOString())
    .gte('result_count', 1)
    .limit(1000)

  let trending: TrendingSearchItem[] = []

  if (!error && analyticsData?.length) {
    const queryStats = new Map<string, { count: number; totalResults: number }>()

    analyticsData.forEach(({ query, result_count }: { query: string; result_count: number }) => {
      if (!query || query.length < 2) return
      const normalizedQuery = query.toLowerCase().trim()
      if (normalizedQuery.length < 2) return
      const current = queryStats.get(normalizedQuery) || { count: 0, totalResults: 0 }
      current.count += 1
      current.totalResults += result_count || 0
      queryStats.set(normalizedQuery, current)
    })

    const sortedQueries = Array.from(queryStats.entries())
      .filter(([, stats]) => stats.count >= 3)
      .sort(([, a], [, b]) => {
        const scoreA = a.count * 2 + (a.totalResults / a.count) * 0.1
        const scoreB = b.count * 2 + (b.totalResults / b.count) * 0.1
        return scoreB - scoreA
      })
      .slice(0, 20)

    trending = sortedQueries.map(([q, stats], index) => {
      let category: TrendingSearchItem['category'] = 'general'
      if (/^[A-Z]{2,6}$/.test(q.toUpperCase())) {
        category = 'token'
      } else if (q.includes('@') || /binance|bybit|okx|bitget|mexc/i.test(q)) {
        category = 'trader'
      }
      return { query: q, searchCount: stats.count, rank: index + 1, category }
    })
  }

  const fallbackQueries = [
    'BTC', 'ETH', 'SOL', 'PEPE', 'WIF',
    'Binance', 'Bybit', 'OKX', 'Bitget',
    'Futures', 'Spot', 'Options', 'NFT', 'DeFi',
  ]

  const result: TrendingSearchResponse = {
    trending: trending.length >= 5 ? trending : [],
    fallback: fallbackQueries,
    lastUpdated: new Date().toISOString(),
  }

  try {
    await cacheSet(cacheKey, result, { ttl: 3600 })
  } catch {
    // Intentionally swallowed: cache write failure is non-critical
  }

  return success(result, 200, {
    'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  })
}

// ---------- Hot searches ----------

interface HotSearchItem {
  keyword: string
  count: number
  trend: 'up' | 'down' | 'stable'
}

function extractKeyword(title: string): string | null {
  if (!title || title.length < 2) return null

  const symbolMatch = title.match(/\$([A-Z]{2,10})/i)
  if (symbolMatch) return symbolMatch[1].toUpperCase()

  const hashMatch = title.match(/#(\S{2,20})/)
  if (hashMatch) return hashMatch[1]

  const cleaned = title
    .replace(/[【】\[\]()（）「」《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const words = cleaned.split(/\s+/).filter(w => w.length >= 2)
  if (words.length === 0) return null

  let result = ''
  for (const word of words) {
    if ((result + ' ' + word).trim().length > 12) break
    result = (result + ' ' + word).trim()
  }

  return result || null
}

async function handleHotSearch(supabase: Parameters<Parameters<typeof withPublic>[0]>[0]['supabase']) {
  const CACHE_KEY = 'search:hot:v1'

  const cached = await cacheGet<HotSearchItem[]>(CACHE_KEY)
  if (cached) {
    return success({ hotSearches: cached }, 200, {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    })
  }

  const hotSearches: HotSearchItem[] = []

  if (features.social) {
    const { data: hotPosts } = await supabase
      .from('posts')
      .select('title, hot_score, view_count, like_count, comment_count')
      .not('title', 'is', null)
      .order('hot_score', { ascending: false, nullsFirst: false })
      .limit(20)

    const seenKeywords = new Set<string>()

    if (hotPosts && hotPosts.length > 0) {
      for (const post of hotPosts) {
        if (hotSearches.length >= 5) break
        if (!post.title) continue
        const keyword = extractKeyword(post.title)
        if (!keyword || seenKeywords.has(keyword.toLowerCase())) continue
        seenKeywords.add(keyword.toLowerCase())
        const score = post.hot_score ||
          (post.view_count || 0) * 0.1 +
          (post.like_count || 0) * 2 +
          (post.comment_count || 0) * 3
        hotSearches.push({
          keyword,
          count: Math.round(score),
          trend: score > 50 ? 'up' : score > 20 ? 'stable' : 'down',
        })
      }
    }
  }

  if (hotSearches.length === 0) {
    hotSearches.push(
      { keyword: 'BTC', count: 1000, trend: 'up' },
      { keyword: 'ETH', count: 800, trend: 'up' },
      { keyword: 'SOL', count: 500, trend: 'stable' },
    )
  }

  await cacheSet(CACHE_KEY, hotSearches, { ttl: 300 })

  return success({ hotSearches }, 200, {
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
  })
}

// ---------- Click-through tracking ----------

// GDPR: Click tracking stores user behavior data in search_analytics.
// Only tracked for aggregate analytics (no PII stored). The search_analytics
// table is restricted to service_role access via RLS.
async function handleClickTracking(
  supabase: Parameters<Parameters<typeof withPublic>[0]>[0]['supabase'],
  searchParams: URLSearchParams,
) {
  const query = searchParams.get('q')?.trim()
  const resultId = searchParams.get('id')
  const resultType = searchParams.get('rtype')

  if (!query || !resultId) {
    return success({ ok: true })
  }

  fireAndForget(
    supabase.from('search_analytics').insert({
      query: query.slice(0, 200),
      result_count: 1,
      source: 'click',
      clicked_result_id: resultId.slice(0, 200),
      clicked_result_type: resultType?.slice(0, 20) || null,
    }).then(),
    'Record search click-through'
  )

  return success({ ok: true })
}

// ---------- Input validation schema ----------

const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).catch(5),
  type: z.enum(['trending', 'hot', 'click']).optional(),
  platform: z.string().max(50).optional(),
  // Click tracking params
  id: z.string().max(200).optional(),
  rtype: z.string().max(20).optional(),
})

// ---------- Main unified search ----------

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const rawParams = Object.fromEntries(searchParams)
    const parsed = searchQuerySchema.safeParse(rawParams)
    if (!parsed.success) {
      return success({
        query: '',
        results: { traders: [], posts: [], library: [], users: [], groups: [] },
        total: 0,
        error: 'Invalid parameters',
      } as UnifiedSearchResponse & { error: string })
    }

    const searchType = parsed.data.type

    if (searchType === 'trending') {
      return handleTrendingSearch(supabase)
    }
    if (searchType === 'hot') {
      return handleHotSearch(supabase)
    }
    if (searchType === 'click') {
      return handleClickTracking(supabase, searchParams)
    }

    const query = parsed.data.q?.trim()
    const limitPerCategory = Math.min(parsed.data.limit, 10)
    const platformFilter = parsed.data.platform || undefined

    if (!query || query.length < 1) {
      return success({
        query: '',
        results: { traders: [], posts: [], library: [], users: [], groups: [] },
        total: 0,
      } satisfies UnifiedSearchResponse)
    }

    // Cache check
    const cacheKey = `search:unified:v2:${query.toLowerCase().slice(0, 50)}:${limitPerCategory}:${platformFilter || ''}`
    try {
      const cached = await cacheGet<UnifiedSearchResponse>(cacheKey)
      if (cached) {
        return success(cached)
      }
    } catch {
      // Intentionally swallowed: Redis cache miss or unavailable
    }

    // Sanitize
    const sanitizedQuery = query
      .slice(0, 100)
      .replace(/<[^>]*>/g, '')
      .replace(/[\\%_]/g, (c) => `\\${c}`)
      .replace(/[.,()]/g, '')

    if (!sanitizedQuery) {
      return success({
        query: query.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        results: { traders: [], posts: [], library: [], users: [], groups: [] },
        total: 0,
      } satisfies UnifiedSearchResponse)
    }

    // Exchange name match (e.g., "binance" -> show top Binance traders)
    const matchedExchange = platformFilter ? platformFilter : matchExchangeName(sanitizedQuery)

    // Stats-based query (e.g., "ROI > 100", "top bybit")
    const statsFilter = parseStatsQuery(sanitizedQuery)

    const effectivePlatform = statsFilter?.platform || (matchedExchange && !platformFilter ? matchedExchange : platformFilter)
    const effectiveLimit = matchedExchange && !platformFilter ? Math.max(limitPerCategory, 10) : limitPerCategory

    // Parallel queries
    const safeQuery = async <T>(promise: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> => {
      try {
        const { data, error } = await promise
        if (error) return []
        return data ?? []
      } catch {
        return []
      }
    }

    interface PostRow { id: string; title: string | null; author_handle: string | null; created_at: string; view_count: number | null }
    interface LibraryRow { id: string; title: string; author: string | null; slug: string | null; category: string | null }
    interface UserRow { id: string; handle: string | null; display_name: string | null; avatar_url: string | null; bio: string | null }
    interface GroupRow { id: string; name: string; member_count: number | null; description: string | null }

    // Try Meilisearch first (1-6ms), fall back to Supabase (100-300ms)
    let meliFacetDistribution: Record<string, Record<string, number>> | undefined
    const meiliTraderSearch = isMeilisearchAvailable() && sanitizedQuery.length >= 2
      ? searchTradersMeili(sanitizedQuery, { limit: effectiveLimit, platform: effectivePlatform || undefined, season: '90D' })
          .then(result => {
            if (!result) return null
            // Capture facet distribution for response
            if (result.facetDistribution) meliFacetDistribution = result.facetDistribution
            return result.hits.map(h => ({
              handle: h.handle,
              traderKey: h.id.split('--').slice(1, -1).join('--') || h.id.split('--')[1] || h.handle,
              platform: h.platform,
              roi: h.roi,
              pnl: h.pnl,
              arenaScore: h.arena_score,
              rank: h.rank,
              avatarUrl: h.avatar_url,
              traderType: h.trader_type,
            }))
          })
          .catch(() => null)
      : Promise.resolve(null)

    const [meiliResults, supabaseTraders, postsData, libraryData, usersData, groupsData] = await Promise.all([
      meiliTraderSearch,
      // Supabase fallback (skipped if Meilisearch returns results)
      unifiedSearchTraders(supabase, {
        query: matchedExchange && !platformFilter ? '' : sanitizedQuery,
        limit: effectiveLimit,
        platform: effectivePlatform,
      }).catch(() => []),

      // Posts: use ILIKE directly (1K rows, fast) — skip textSearch→ILIKE fallback chain
      features.social
        ? safeQuery(supabase
            .from('posts')
            .select('id, title, author_handle, created_at, view_count')
            .or(`title.ilike.%${sanitizedQuery}%`)
            .eq('visibility', 'public')
            .order('view_count', { ascending: false, nullsFirst: false })
            .limit(limitPerCategory))
        : Promise.resolve([]),

      safeQuery(supabase
        .from('library_items')
        .select('id, title, author, slug, category')
        .or(
          `title.ilike.%${sanitizedQuery}%,author.ilike.%${sanitizedQuery}%`
        )
        .limit(limitPerCategory)),

      features.social
        ? safeQuery(supabase
            .from('user_profiles')
            .select('id, handle, display_name, avatar_url, bio')
            .or(
              `handle.ilike.%${sanitizedQuery}%,display_name.ilike.%${sanitizedQuery}%,bio.ilike.%${sanitizedQuery}%`
            )
            .limit(limitPerCategory))
        : Promise.resolve([]),

      features.social
        ? safeQuery(supabase
            .from('groups')
            .select('id, name, member_count, description')
            .ilike('name', `%${sanitizedQuery}%`)
            .limit(limitPerCategory))
        : Promise.resolve([]),
    ])

    // For exchange name search, fetch top traders from leaderboard if direct search returned nothing
    // Use Meilisearch results if available (1-6ms), otherwise Supabase (100-300ms)
    let exchangeTopTraders = (meiliResults && meiliResults.length > 0) ? meiliResults : supabaseTraders
    if (matchedExchange && !platformFilter && exchangeTopTraders.length === 0) {
      try {
        const { getLeaderboard } = await import('@/lib/data/unified')
        const { traders: topTraders } = await getLeaderboard(supabase, {
          platform: matchedExchange,
          limit: effectiveLimit,
          period: '90D',
        })
        exchangeTopTraders = topTraders
      } catch {
        // Leaderboard fetch failed
      }
    }

    // Sort traders by relevance score (Meilisearch-inspired weighted ranking)
    // When searching for an exchange name, prioritize arena_score (best traders first).
    // For text searches, prioritize text match quality.
    const isExchangeSearch = !!matchedExchange && !platformFilter
    const scoredTraders = exchangeTopTraders.map(t => {
      let relevance = 0
      if (isExchangeSearch) {
        // Exchange search: sort by arena_score (most relevant = best performer)
        relevance = (t.arenaScore ?? 0)
      } else {
        const handle = (t.handle || t.traderKey || '').toLowerCase()
        const q = sanitizedQuery.toLowerCase()
        if (handle === q) relevance += 100 // Exact match
        else if (handle.startsWith(q)) relevance += 50 // Prefix match
        else if (handle.includes(q)) relevance += 20 // Contains
        relevance += Math.min((t.arenaScore ?? 0) / 2, 30) // Score bonus (max 30)
        relevance += Math.min(Math.log10(Math.max(t.roi ?? 1, 1)) * 5, 15) // ROI bonus (max 15)
      }
      return { ...t, _relevance: relevance }
    }).sort((a, b) => b._relevance - a._relevance)

    // Map traders to UnifiedSearchResult
    const traders: UnifiedSearchResult[] = scoredTraders.map((t) => {
      const exchangeName = EXCHANGE_CONFIG[t.platform as keyof typeof EXCHANGE_CONFIG]?.name || t.platform
      const isBot = t.traderType === 'bot' || t.platform === 'web3_bot'
      const roiStr = t.roi != null ? `${t.roi >= 0 ? '+' : ''}${t.roi >= 1000 ? `${(t.roi / 1000).toFixed(1)}K` : t.roi.toFixed(1)}%` : null
      const rankStr = t.rank != null ? `#${t.rank}` : null
      const subtitle = [exchangeName, rankStr, roiStr, t.arenaScore != null ? `Score ${Math.round(t.arenaScore)}` : null].filter(Boolean).join(' \u00B7 ')
      return {
        id: `${t.platform}:${t.traderKey}`,
        type: 'trader' as const,
        title: `@${t.handle || t.traderKey}`,
        subtitle,
        href: `/trader/${encodeURIComponent(t.handle || t.traderKey)}?platform=${t.platform}`,
        avatar: t.avatarUrl || null,
        meta: {
          ...(isBot ? { is_bot: true } : {}),
          ...(t.roi != null ? { roi: t.roi } : {}),
          ...(t.arenaScore != null ? { arena_score: t.arenaScore } : {}),
          ...(t.rank != null ? { rank: t.rank } : {}),
          platform: t.platform,
        },
      }
    })

    const posts: UnifiedSearchResult[] = (postsData as PostRow[]).map((p) => ({
      id: p.id,
      type: 'post' as const,
      title: p.title || 'Untitled',
      subtitle: p.author_handle ? `@${p.author_handle}` : undefined,
      href: `/post/${p.id}`,
      meta: { view_count: p.view_count },
    }))

    const library: UnifiedSearchResult[] = (libraryData as LibraryRow[]).map(
      (l) => ({
        id: l.id,
        type: 'library' as const,
        title: l.title,
        subtitle: l.author || l.category || undefined,
        href: `/learn/${l.slug || l.id}`,
      })
    )

    const users: UnifiedSearchResult[] = (usersData as UserRow[]).map((u) => ({
      id: u.id,
      type: 'user' as const,
      title: u.display_name || `@${u.handle}`,
      subtitle: u.handle ? `@${u.handle}` : undefined,
      href: `/u/${encodeURIComponent(u.handle || u.id)}`,
      avatar: u.avatar_url,
    }))

    const groups: UnifiedSearchResult[] = (groupsData as GroupRow[]).map((g) => ({
      id: g.id,
      type: 'group' as const,
      title: g.name,
      subtitle: g.description || undefined,
      href: `/groups/${g.id}`,
      meta: { member_count: g.member_count },
    }))

    const totalResults = traders.length + posts.length + library.length + users.length + groups.length

    // "Did you mean" suggestions — combines trader handles + hot posts + popular groups
    let suggestions: string[] | undefined
    if (totalResults <= 2 && sanitizedQuery.length >= 3 && !matchedExchange) {
      const [traderSuggestions, hotPostSuggestions, groupSuggestions] = await Promise.all([
        // Trader handle suggestions (weighted by arena_score + followers)
        getSearchSuggestions(supabase, sanitizedQuery),
        // Hot post titles containing similar keywords
        features.social
          ? supabase
              .from('posts')
              .select('title')
              .not('title', 'is', null)
              .or(`title.ilike.%${sanitizedQuery.slice(0, 20)}%`)
              .order('hot_score', { ascending: false, nullsFirst: false })
              .limit(2)
              .then(({ data }) => (data || []).map((p: { title: string }) => p.title).filter(Boolean))
          : Promise.resolve([]),
        // Popular groups with similar names
        features.social
          ? supabase
              .from('groups')
              .select('name')
              .ilike('name', `%${sanitizedQuery.slice(0, 20)}%`)
              .order('member_count', { ascending: false, nullsFirst: false })
              .limit(2)
              .then(({ data }) => (data || []).map((g: { name: string }) => g.name).filter(Boolean))
          : Promise.resolve([]),
      ])
      // Merge & dedupe: trader handles first, then hot posts, then groups
      const allSuggestions = [...new Set([
        ...traderSuggestions,
        ...hotPostSuggestions,
        ...groupSuggestions,
      ])].slice(0, 5)
      if (allSuggestions.length > 0) suggestions = allSuggestions
    }

    const escapedQuery = query.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const result: UnifiedSearchResponse = {
      query: escapedQuery,
      results: { traders, posts, library, users, groups },
      total: totalResults,
      ...(suggestions ? { suggestions } : {}),
      ...(matchedExchange && !platformFilter ? { matchedExchange } : {}),
      ...(meliFacetDistribution ? { facetDistribution: meliFacetDistribution } : {}),
    }

    const cacheTtl = totalResults > 5 ? 600 : 300
    try {
      await cacheSet(cacheKey, result, { ttl: cacheTtl })
    } catch {
      // Intentionally swallowed: cache write failure is non-critical
    }

    // Search analytics (async)
    fireAndForget(
      supabase.from('search_analytics').insert({
        query: query.slice(0, 200),
        result_count: totalResults,
        source: 'unified',
      }).then(),
      'Record search analytics'
    )

    return success(result, 200, {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    })
  },
  { name: 'unified-search', rateLimit: { requests: 20, window: 60, prefix: 'search' } }
)
