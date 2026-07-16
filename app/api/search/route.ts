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
import { success, badRequest } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet, getOrSetWithLock } from '@/lib/cache'
import { fireAndForget, createLogger } from '@/lib/utils/logger'

const logger = createLogger('search-api')
import { features } from '@/lib/features'
import { searchTraders as unifiedSearchTraders, getSearchSuggestions } from '@/lib/data/unified'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { searchTradersMeili, isMeilisearchAvailable } from '@/lib/search/meilisearch'
import { isMaliciousSearchQuery } from '@/lib/utils/search-sanitize'
import { escapeLikePattern } from '@/lib/sanitize'
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'

// Redis stores only server-side candidates. Any payload derived from posts is
// re-authorized for the current anonymous audience and is never CDN-cached.

export interface UnifiedSearchResult {
  id: string
  type: 'trader' | 'post' | 'user' | 'group'
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
  /** true when Meilisearch is unavailable and results fell back to Supabase (slower, less fuzzy) */
  degraded?: boolean
}

interface SearchSuggestionCandidateSet {
  traders: string[]
  posts: Array<{ id: string; title: string }>
  groups: Array<{ id: string; name: string }>
}

interface UnifiedSearchCacheCandidate {
  result: Omit<UnifiedSearchResponse, 'suggestions'>
  /** Escaped DB pattern used to prove group names still match on cache hits. */
  groupQuery: string
  suggestionCandidates?: SearchSuggestionCandidateSet
}

type SearchPostAudienceCandidate =
  | { id: string; source: 'result'; result: UnifiedSearchResult }
  | { id: string; source: 'suggestion'; title: string }

const SEARCH_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const DISCOVERABLE_GROUP_VISIBILITIES = ['open', 'apply'] as const

type PublicSearchSupabase = Parameters<Parameters<typeof withPublic>[0]>[0]['supabase']

interface CurrentSearchGroup {
  id: string
  name: string
  description: string | null
  member_count: number | null
}

async function readCurrentSearchGroups(
  supabase: PublicSearchSupabase,
  groupIds: string[],
  groupQuery: string
): Promise<Map<string, CurrentSearchGroup>> {
  if (groupIds.length === 0 || typeof groupQuery !== 'string' || !groupQuery) return new Map()
  try {
    const { data, error } = await supabase
      .from('groups')
      .select('id, name, description, member_count')
      .in('id', groupIds)
      .ilike('name', `%${groupQuery}%`)
      .is('dissolved_at', null)
      .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
    if (error) return new Map()

    const currentGroups = new Map<string, CurrentSearchGroup>()
    for (const group of data ?? []) {
      if (
        typeof group.id !== 'string' ||
        typeof group.name !== 'string' ||
        (group.description !== null && typeof group.description !== 'string') ||
        (group.member_count !== null && typeof group.member_count !== 'number')
      ) {
        continue
      }
      currentGroups.set(group.id, group)
    }
    return currentGroups
  } catch {
    return new Map()
  }
}

async function readCurrentSearchUserIds(
  supabase: PublicSearchSupabase,
  userIds: string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  try {
    const { data, error } = await supabase
      .from('public_user_profiles')
      .select('id')
      .in('id', userIds)
    if (error) return new Set()
    return new Set((data ?? []).map((user) => user.id).filter((id): id is string => !!id))
  } catch {
    return new Set()
  }
}

async function materializeUnifiedSearchCandidate(
  supabase: PublicSearchSupabase,
  candidate: UnifiedSearchCacheCandidate
): Promise<UnifiedSearchResponse> {
  const resultPostCandidates: SearchPostAudienceCandidate[] = candidate.result.results.posts.map(
    (result) => ({
      id: result.id,
      source: 'result',
      result,
    })
  )
  const suggestionPostCandidates: SearchPostAudienceCandidate[] =
    candidate.suggestionCandidates?.posts.map((post) => ({
      id: post.id,
      source: 'suggestion',
      title: post.title,
    })) ?? []

  const groupIds = [
    ...new Set(
      [
        ...candidate.result.results.groups.map((group) => group.id),
        ...(candidate.suggestionCandidates?.groups.map((group) => group.id) ?? []),
      ].filter((groupId): groupId is string => typeof groupId === 'string' && !!groupId)
    ),
  ]
  const userIds = [...new Set(candidate.result.results.users.map((user) => user.id))]
  const [readablePostCandidates, currentGroups, currentUserIds] = await Promise.all([
    filterServiceReadablePostRows(
      supabase,
      [...resultPostCandidates, ...suggestionPostCandidates],
      null
    ),
    readCurrentSearchGroups(supabase, groupIds, candidate.groupQuery),
    readCurrentSearchUserIds(supabase, userIds),
  ])
  const posts = readablePostCandidates
    .filter(
      (post): post is Extract<SearchPostAudienceCandidate, { source: 'result' }> =>
        post.source === 'result'
    )
    .map((post) => post.result)
  const postSuggestions = readablePostCandidates
    .filter(
      (post): post is Extract<SearchPostAudienceCandidate, { source: 'suggestion' }> =>
        post.source === 'suggestion'
    )
    .map((post) => post.title)
  // Never return mutable fields from the Redis candidate. Rebuild every group
  // result from its current discoverable row so edits/removals take effect on
  // the very next cache hit.
  const groups = candidate.result.results.groups
    .map((candidateGroup): UnifiedSearchResult | null => {
      const group = currentGroups.get(candidateGroup.id)
      if (!group) return null
      return {
        id: group.id,
        type: 'group',
        title: group.name,
        subtitle: group.description || undefined,
        href: `/groups/${encodeURIComponent(group.id)}`,
        meta: { member_count: group.member_count },
      }
    })
    .filter((group): group is UnifiedSearchResult => group !== null)
  const users = candidate.result.results.users.filter((user) => currentUserIds.has(user.id))
  const groupSuggestions =
    candidate.suggestionCandidates?.groups
      .map((group) => currentGroups.get(group.id)?.name)
      .filter((name): name is string => typeof name === 'string') ?? []
  const suggestions = candidate.suggestionCandidates
    ? [
        ...new Set([
          ...candidate.suggestionCandidates.traders,
          ...postSuggestions,
          ...groupSuggestions,
        ]),
      ].slice(0, 5)
    : []
  const results = { ...candidate.result.results, posts, users, groups }

  return {
    ...candidate.result,
    results,
    total: results.traders.length + posts.length + results.users.length + results.groups.length,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  }
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

async function handleTrendingSearch(
  supabase: Parameters<Parameters<typeof withPublic>[0]>[0]['supabase']
) {
  const trending = await getOrSetWithLock(
    'search:trending:queries',
    async () => {
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

      const { data: analyticsData, error } = await supabase
        .from('search_analytics')
        .select('query, result_count, created_at')
        .gte('created_at', sevenDaysAgo.toISOString())
        .gte('result_count', 1)
        .limit(1000)

      let trendingItems: TrendingSearchItem[] = []

      if (!error && analyticsData?.length) {
        const queryStats = new Map<string, { count: number; totalResults: number }>()

        analyticsData.forEach(
          ({ query, result_count }: { query: string; result_count: number }) => {
            if (!query || query.length < 2) return
            const normalizedQuery = query.toLowerCase().trim()
            if (normalizedQuery.length < 2) return
            // Skip malicious/SQL-injection search terms so they never appear as pills
            if (isMaliciousSearchQuery(normalizedQuery)) return
            const current = queryStats.get(normalizedQuery) || { count: 0, totalResults: 0 }
            current.count += 1
            current.totalResults += result_count || 0
            queryStats.set(normalizedQuery, current)
          }
        )

        const sortedQueries = Array.from(queryStats.entries())
          .filter(([, stats]) => stats.count >= 3)
          .sort(([, a], [, b]) => {
            const scoreA = a.count * 2 + (a.totalResults / a.count) * 0.1
            const scoreB = b.count * 2 + (b.totalResults / b.count) * 0.1
            return scoreB - scoreA
          })
          .slice(0, 20)

        trendingItems = sortedQueries.map(([q, stats], index) => {
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
        'BTC',
        'ETH',
        'SOL',
        'PEPE',
        'WIF',
        'Binance',
        'Bybit',
        'OKX',
        'Bitget',
        'Futures',
        'Spot',
        'Options',
        'NFT',
        'DeFi',
      ]

      return {
        trending: trendingItems.length >= 5 ? trendingItems : [],
        fallback: fallbackQueries,
        lastUpdated: new Date().toISOString(),
      } satisfies TrendingSearchResponse
    },
    { ttl: 300 }
  )

  return success(trending, 200, {
    'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  })
}

// ---------- Hot searches ----------

interface HotSearchItem {
  keyword: string
  count: number
  trend: 'up' | 'down' | 'stable'
}

interface HotPostCandidate {
  id: string
  title: string | null
  hot_score: number | null
  view_count: number | null
  like_count: number | null
  comment_count: number | null
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

  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2)
  if (words.length === 0) return null

  let result = ''
  for (const word of words) {
    if ((result + ' ' + word).trim().length > 12) break
    result = (result + ' ' + word).trim()
  }

  return result || null
}

async function handleHotSearch(
  supabase: Parameters<Parameters<typeof withPublic>[0]>[0]['supabase']
) {
  const CACHE_KEY = 'search:hot:v2:candidates'

  let hotPostCandidates = features.social ? await cacheGet<HotPostCandidate[]>(CACHE_KEY) : []

  if (!hotPostCandidates && features.social) {
    const { data: hotPosts } = await supabase
      .from('posts')
      .select('id, title, hot_score, view_count, like_count, comment_count')
      .not('title', 'is', null)
      .order('hot_score', { ascending: false, nullsFirst: false })
      .limit(20)

    hotPostCandidates = (hotPosts as HotPostCandidate[] | null) ?? []
    await cacheSet(CACHE_KEY, hotPostCandidates, { ttl: 300 })
  }

  const readableHotPosts = await filterServiceReadablePostRows(
    supabase,
    hotPostCandidates ?? [],
    null
  )
  const hotSearches: HotSearchItem[] = []
  const seenKeywords = new Set<string>()

  for (const post of readableHotPosts) {
    if (hotSearches.length >= 5) break
    if (!post.title) continue
    const keyword = extractKeyword(post.title)
    if (!keyword || seenKeywords.has(keyword.toLowerCase())) continue
    // Skip malicious keywords extracted from post titles
    if (isMaliciousSearchQuery(keyword)) continue
    seenKeywords.add(keyword.toLowerCase())
    const score =
      post.hot_score ||
      (post.view_count || 0) * 0.1 + (post.like_count || 0) * 2 + (post.comment_count || 0) * 3
    hotSearches.push({
      keyword,
      count: Math.round(score),
      trend: score > 50 ? 'up' : score > 20 ? 'stable' : 'down',
    })
  }

  if (hotSearches.length === 0) {
    hotSearches.push(
      { keyword: 'BTC', count: 1000, trend: 'up' },
      { keyword: 'ETH', count: 800, trend: 'up' },
      { keyword: 'SOL', count: 500, trend: 'stable' }
    )
  }

  return success({ hotSearches }, 200, {
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
  })
}

// ---------- Click-through tracking ----------

// GDPR: Click tracking stores user behavior data in search_analytics.
// Only tracked for aggregate analytics (no PII stored). The search_analytics
// table is restricted to service_role access via RLS.
async function handleClickTracking(
  supabase: Parameters<Parameters<typeof withPublic>[0]>[0]['supabase'],
  searchParams: URLSearchParams
) {
  const query = searchParams.get('q')?.trim()
  const resultId = searchParams.get('id')
  const resultType = searchParams.get('rtype')

  if (!query || !resultId) {
    return success({ ok: true })
  }

  fireAndForget(
    supabase
      .from('search_analytics')
      .insert({
        query: query.slice(0, 200),
        result_count: 1,
        source: 'click',
        clicked_result_id: resultId.slice(0, 200),
        clicked_result_type: resultType?.slice(0, 20) || null,
      })
      .then(),
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
      return badRequest('Invalid search parameters')
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
        results: { traders: [], posts: [], users: [], groups: [] },
        total: 0,
      } satisfies UnifiedSearchResponse)
    }

    // Cache check
    const cacheKey = `search:unified:v4:candidates:${query.toLowerCase().slice(0, 50)}:${limitPerCategory}:${platformFilter || ''}`
    try {
      const cached = await cacheGet<UnifiedSearchCacheCandidate>(cacheKey)
      if (cached) {
        const result = await materializeUnifiedSearchCandidate(supabase, cached)
        return success(result, 200, SEARCH_NO_STORE_HEADERS)
      }
    } catch {
      // Intentionally swallowed: Redis cache miss or unavailable
    }

    // Sanitize
    const sanitizedQuery = escapeLikePattern(
      query
        .slice(0, 100)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
        .replace(/<[^>]*>/g, ''),
      100
    )

    if (!sanitizedQuery) {
      return success({
        query: query.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        results: { traders: [], posts: [], users: [], groups: [] },
        total: 0,
      } satisfies UnifiedSearchResponse)
    }

    // Exchange name match (e.g., "binance" -> show top Binance traders)
    const matchedExchange = platformFilter ? platformFilter : matchExchangeName(sanitizedQuery)

    // Stats-based query (e.g., "ROI > 100", "top bybit")
    const statsFilter = parseStatsQuery(sanitizedQuery)

    const effectivePlatform =
      statsFilter?.platform ||
      (matchedExchange && !platformFilter ? matchedExchange : platformFilter)
    const effectiveLimit =
      matchedExchange && !platformFilter ? Math.max(limitPerCategory, 10) : limitPerCategory

    // Parallel queries
    const safeQuery = async <T>(
      promise: PromiseLike<{ data: T[] | null; error: unknown }>,
      label = 'query'
    ): Promise<T[]> => {
      try {
        const { data, error } = await promise
        if (error) {
          // Don't fold a column/table error (42703 / PGRST205 — e.g. the known
          // display_name drift) into a silent empty result set; log so drift
          // surfaces instead of looking like "no results".
          logger.warn(`Search ${label} failed`, {
            error: error instanceof Error ? error.message : String(error),
          })
          return []
        }
        return data ?? []
      } catch (e) {
        logger.warn(`Search ${label} threw`, { error: e instanceof Error ? e.message : String(e) })
        return []
      }
    }

    interface PostRow {
      id: string
      title: string | null
      author_handle: string | null
      created_at: string
      view_count: number | null
    }
    interface UserRow {
      id: string
      handle: string | null
      avatar_url: string | null
      bio: string | null
    }
    interface GroupRow {
      id: string
      name: string
      member_count: number | null
      description: string | null
    }

    // Try Meilisearch first (1-6ms), fall back to Supabase (100-300ms)
    let meliFacetDistribution: Record<string, Record<string, number>> | undefined
    let meiliDegraded = false
    const meiliTraderSearch =
      isMeilisearchAvailable() && sanitizedQuery.length >= 2
        ? searchTradersMeili(sanitizedQuery, {
            limit: effectiveLimit,
            platform: effectivePlatform || undefined,
            season: '90D',
          })
            .then((result) => {
              if (!result) return null
              // Capture facet distribution for response
              if (result.facetDistribution) meliFacetDistribution = result.facetDistribution
              return result.hits.map((h) => ({
                handle: h.handle,
                traderKey:
                  h.id.split('--').slice(1, -1).join('--') || h.id.split('--')[1] || h.handle,
                platform: h.platform,
                roi: h.roi,
                pnl: h.pnl,
                arenaScore: h.arena_score,
                rank: h.rank,
                avatarUrl: h.avatar_url,
                traderType: h.trader_type,
              }))
            })
            .catch((err) => {
              logger.warn('Meilisearch trader search failed, falling back to Supabase', {
                error: err instanceof Error ? err.message : String(err),
                query: sanitizedQuery,
              })
              meiliDegraded = true
              return null
            })
        : Promise.resolve(null)

    const [meiliResults, initialSupabaseTraders, postsData, usersData, groupsData] =
      await Promise.all([
        meiliTraderSearch,
        // Supabase trader search: only run when Meilisearch is NOT configured.
        // Previously ran both in parallel and discarded Supabase results ~90% of the time,
        // wasting a DB connection pool slot per search request.
        isMeilisearchAvailable()
          ? Promise.resolve([])
          : unifiedSearchTraders(supabase, {
              query: matchedExchange && !platformFilter ? '' : sanitizedQuery,
              limit: effectiveLimit,
              platform: effectivePlatform,
            }).catch((err) => {
              logger.warn('Supabase trader search failed', {
                error: err instanceof Error ? err.message : String(err),
                query: sanitizedQuery,
              })
              return []
            }),

        // Posts: use ILIKE directly (1K rows, fast) — skip textSearch→ILIKE fallback chain
        features.social
          ? safeQuery(
              supabase
                .from('posts')
                .select('id, title, author_handle, created_at, view_count')
                .or(`title.ilike.%${sanitizedQuery}%`)
                .eq('visibility', 'public')
                .order('view_count', { ascending: false, nullsFirst: false })
                .limit(limitPerCategory)
            )
          : Promise.resolve([]),

        features.social
          ? safeQuery(
              supabase
                .from('public_user_profiles')
                // The public projection excludes account-private columns and
                // deleted profiles before the service client can see them.
                .select('id, handle, avatar_url, bio')
                .ilike('handle', `%${sanitizedQuery}%`)
                .limit(limitPerCategory)
            )
          : Promise.resolve([]),

        features.social
          ? safeQuery(
              supabase
                .from('groups')
                .select('id, name, member_count, description')
                .ilike('name', `%${sanitizedQuery}%`)
                .is('dissolved_at', null)
                .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
                .limit(limitPerCategory)
            )
          : Promise.resolve([]),
      ])
    let supabaseTraders = initialSupabaseTraders

    // The public search route uses a service client. Visibility='public' is
    // not sufficient for group-paid posts, repost roots, account state, or
    // block edges, so release only rows approved for the anonymous actor.
    const readablePostsData = await filterServiceReadablePostRows(
      supabase,
      postsData as PostRow[],
      null
    )

    // If Meilisearch was configured but failed at runtime, run Supabase fallback now
    if (meiliDegraded && supabaseTraders.length === 0) {
      try {
        const fallback = await unifiedSearchTraders(supabase, {
          query: matchedExchange && !platformFilter ? '' : sanitizedQuery,
          limit: effectiveLimit,
          platform: effectivePlatform,
        })
        supabaseTraders = fallback
      } catch {
        /* already logged above */
      }
    }

    // For exchange name search, fetch top traders from leaderboard if direct search returned nothing
    // Use Meilisearch results if available (1-6ms), otherwise Supabase (100-300ms)
    let exchangeTopTraders =
      meiliResults && meiliResults.length > 0 ? meiliResults : supabaseTraders
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
    const scoredTraders = exchangeTopTraders
      .map((t) => {
        let relevance = 0
        if (isExchangeSearch) {
          // Exchange search: sort by arena_score (most relevant = best performer)
          relevance = t.arenaScore ?? 0
        } else {
          const handle = (t.handle || t.traderKey || '').toLowerCase()
          const q = sanitizedQuery.toLowerCase()
          if (handle === q)
            relevance += 100 // Exact match
          else if (handle.startsWith(q))
            relevance += 50 // Prefix match
          else if (handle.includes(q)) relevance += 20 // Contains
          relevance += Math.min((t.arenaScore ?? 0) / 2, 30) // Score bonus (max 30)
          relevance += Math.min(Math.log10(Math.max(t.roi ?? 1, 1)) * 5, 15) // ROI bonus (max 15)
        }
        return { ...t, _relevance: relevance }
      })
      .sort((a, b) => b._relevance - a._relevance)

    // Map traders to UnifiedSearchResult
    const traders: UnifiedSearchResult[] = scoredTraders.map((t) => {
      const exchangeName =
        EXCHANGE_CONFIG[t.platform as keyof typeof EXCHANGE_CONFIG]?.name || t.platform
      const isBot = t.traderType === 'bot' || t.platform === 'web3_bot'
      const roiStr =
        t.roi != null
          ? `${t.roi >= 0 ? '+' : ''}${t.roi >= 1000 ? `${(t.roi / 1000).toFixed(1)}K` : t.roi.toFixed(1)}%`
          : null
      const rankStr = t.rank != null ? `#${t.rank}` : null
      const subtitle = [
        exchangeName,
        rankStr,
        roiStr,
        t.arenaScore != null ? `Score ${Math.round(t.arenaScore)}` : null,
      ]
        .filter(Boolean)
        .join(' \u00B7 ')
      return {
        id: `${t.platform}:${t.traderKey}`,
        type: 'trader' as const,
        title: `@${t.handle || t.traderKey}`,
        subtitle,
        // Route by real traderKey (source_trader_id), NOT handle. 92% of handles
        // fail /api/traders/<handle> resolution → 404; resolveTrader accepts either
        // handle OR source_trader_id, and the id is always resolvable. (U3-1b)
        href: `/trader/${encodeURIComponent(t.traderKey || t.handle || '')}?platform=${t.platform}`,
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

    const posts: UnifiedSearchResult[] = readablePostsData.map((p) => ({
      id: p.id,
      type: 'post' as const,
      title: p.title || 'Untitled',
      subtitle: p.author_handle ? `@${p.author_handle}` : undefined,
      href: `/post/${p.id}`,
      meta: { view_count: p.view_count },
    }))

    const users: UnifiedSearchResult[] = (usersData as UserRow[]).map((u) => ({
      id: u.id,
      type: 'user' as const,
      title: `@${u.handle}`,
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

    const totalResults = traders.length + posts.length + users.length + groups.length

    // "Did you mean" suggestions — cache source-tagged candidates so post
    // titles can be re-authorized after every Redis hit before materializing.
    let suggestionCandidates: SearchSuggestionCandidateSet | undefined
    if (totalResults <= 2 && sanitizedQuery.length >= 3 && !matchedExchange) {
      const [traderSuggestions, hotPostSuggestions, groupSuggestions] = await Promise.all([
        // Trader handle suggestions (weighted by arena_score + followers)
        getSearchSuggestions(supabase, sanitizedQuery),
        // Hot post titles containing similar keywords
        features.social
          ? supabase
              .from('posts')
              .select('id, title')
              .not('title', 'is', null)
              .or(`title.ilike.%${sanitizedQuery.slice(0, 20)}%`)
              .order('hot_score', { ascending: false, nullsFirst: false })
              .limit(2)
              .then(({ data }) =>
                (data || []).filter(
                  (post): post is { id: string; title: string } =>
                    typeof post.id === 'string' && typeof post.title === 'string'
                )
              )
          : Promise.resolve([]),
        // Popular groups with similar names
        features.social
          ? supabase
              .from('groups')
              .select('id, name')
              .ilike('name', `%${sanitizedQuery.slice(0, 20)}%`)
              .is('dissolved_at', null)
              .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
              .order('member_count', { ascending: false, nullsFirst: false })
              .limit(2)
              .then(({ data }) =>
                (data || []).filter(
                  (group): group is { id: string; name: string } =>
                    typeof group.id === 'string' && typeof group.name === 'string'
                )
              )
          : Promise.resolve([]),
      ])
      const readablePostSuggestions = await filterServiceReadablePostRows(
        supabase,
        hotPostSuggestions,
        null
      )
      suggestionCandidates = {
        traders: traderSuggestions,
        posts: readablePostSuggestions,
        groups: groupSuggestions,
      }
    }

    const escapedQuery = query.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const cacheCandidate: UnifiedSearchCacheCandidate = {
      groupQuery: sanitizedQuery,
      result: {
        query: escapedQuery,
        results: { traders, posts, users, groups },
        total: totalResults,
        ...(matchedExchange && !platformFilter ? { matchedExchange } : {}),
        ...(meliFacetDistribution ? { facetDistribution: meliFacetDistribution } : {}),
        ...(meiliDegraded ? { degraded: true } : {}),
      },
      ...(suggestionCandidates ? { suggestionCandidates } : {}),
    }

    const cacheTtl = totalResults > 5 ? 600 : 300
    try {
      await cacheSet(cacheKey, cacheCandidate, { ttl: cacheTtl })
    } catch {
      // Intentionally swallowed: cache write failure is non-critical
    }

    const result = await materializeUnifiedSearchCandidate(supabase, cacheCandidate)

    // Search analytics (async) — skip malicious queries to keep analytics clean
    if (!isMaliciousSearchQuery(query)) {
      fireAndForget(
        supabase
          .from('search_analytics')
          .insert({
            query: query.slice(0, 200),
            result_count: result.total,
            source: 'unified',
          })
          .then(),
        'Record search analytics'
      )
    }

    return success(result, 200, SEARCH_NO_STORE_HEADERS)
  },
  { name: 'unified-search', rateLimit: { requests: 20, window: 60, prefix: 'search' } }
)
