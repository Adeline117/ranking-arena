/**
 * 统一搜索 API
 * 聚合搜索交易员、帖子、资料库、用户，按类别返回结果
 *
 * GET /api/search?q=xxx             - Unified search
 * GET /api/search?type=trending     - Trending searches (was /api/search/trending)
 * GET /api/search?type=hot          - Hot searches (was /api/search/hot)
 *
 * Merges:
 *   - /api/search/trending (deleted)
 *   - /api/search/hot (deleted)
 *   - /api/search/advanced (deleted, orphaned)
 *   - /api/search/recommend (deleted, orphaned)
 */

import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'
import { fireAndForget } from '@/lib/utils/logger'
import { features } from '@/lib/features'
import { searchTraders as unifiedSearchTraders } from '@/lib/data/unified'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'

export const dynamic = 'force-dynamic'

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
}

// ---------- Trending searches (was /api/search/trending) ----------

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
    // Intentionally swallowed: cache write failure is non-critical, response already built
  }

  return success(result, 200, {
    'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  })
}

// ---------- Hot searches (was /api/search/hot) ----------

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

// ---------- Main unified search ----------

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const searchType = searchParams.get('type')

    // Route to sub-handlers for special types
    if (searchType === 'trending') {
      return handleTrendingSearch(supabase)
    }
    if (searchType === 'hot') {
      return handleHotSearch(supabase)
    }

    const query = searchParams.get('q')?.trim()
    const limitPerCategory = Math.min(
      parseInt(searchParams.get('limit') || '5'),
      10
    )

    if (!query || query.length < 1) {
      return success({
        query: '',
        results: { traders: [], posts: [], library: [], users: [], groups: [] },
        total: 0,
      } satisfies UnifiedSearchResponse)
    }

    // 缓存检查
    const cacheKey = `search:unified:${query.toLowerCase().slice(0, 50)}:${limitPerCategory}`
    try {
      const cached = await cacheGet<UnifiedSearchResponse>(cacheKey)
      if (cached) {
        return success(cached)
      }
    } catch {
      // Intentionally swallowed: Redis cache miss or unavailable, fall through to DB query
    }

    const sanitizedQuery = query
      .slice(0, 100)
      .replace(/[\\%_]/g, (c) => `\\${c}`)
      .replace(/[.,()]/g, '')

    if (!sanitizedQuery) {
      return success({
        query,
        results: { traders: [], posts: [], library: [], users: [], groups: [] },
        total: 0,
      } satisfies UnifiedSearchResponse)
    }

    // 并行查询所有表 — 每个独立容错，不因一个失败影响整体

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

    const [unifiedTraders, postsData, libraryData, usersData, groupsData] = await Promise.all([
      // Use unified data layer for trader search (handles ranking, dead platform filtering internally)
      unifiedSearchTraders(supabase, { query: sanitizedQuery, limit: limitPerCategory }).catch(() => []),

      // Skip social content queries when social feature is disabled
      features.social
        ? safeQuery(supabase
            .from('posts')
            .select('id, title, author_handle, created_at, view_count')
            .or(`title.ilike.%${sanitizedQuery}%`)
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

    // Map unified traders to UnifiedSearchResult format
    const traders: UnifiedSearchResult[] = unifiedTraders.map((t) => {
      const exchangeName = EXCHANGE_CONFIG[t.platform as keyof typeof EXCHANGE_CONFIG]?.name || t.platform
      const isBot = t.traderType === 'bot' || t.platform === 'web3_bot'
      return {
        id: `${t.platform}:${t.traderKey}`,
        type: 'trader' as const,
        title: `@${t.handle || t.traderKey}`,
        subtitle: exchangeName,
        href: `/trader/${encodeURIComponent(t.traderKey)}?platform=${t.platform}`,
        meta: isBot ? { is_bot: true } : undefined,
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
        href: `/library/${l.slug || l.id}`,
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

    const result: UnifiedSearchResponse = {
      query,
      results: { traders, posts, library, users, groups },
      total: traders.length + posts.length + library.length + users.length + groups.length,
    }

    // 缓存 5 分钟（pg_trgm索引加速后可以更长TTL）
    try {
      await cacheSet(cacheKey, result, { ttl: 300 })
    } catch {
      // Intentionally swallowed: cache write failure is non-critical, response already built
    }

    // 搜索分析（异步）
    fireAndForget(
      supabase.from('search_analytics').insert({
        query: query.slice(0, 200),
        result_count: result.total,
        source: 'unified',
      }).then(),
      'Record search analytics'
    )

    return success(result, 200, {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
    })
  },
  { name: 'unified-search', rateLimit: 'read' }
)
