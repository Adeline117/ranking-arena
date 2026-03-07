/**
 * 统一搜索 API
 * 聚合搜索交易员、帖子、资料库、用户，按类别返回结果
 */

import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'
import { fireAndForget } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'

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
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const query = searchParams.get('q')?.trim()
    const limitPerCategory = Math.min(
      parseInt(searchParams.get('limit') || '5'),
      10
    )

    if (!query || query.length < 1) {
      return success({
        query: '',
        results: { traders: [], posts: [], users: [], groups: [] },
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
      // 缓存未命中
    }

    const sanitizedQuery = query
      .slice(0, 100)
      .replace(/[\\%_]/g, (c) => `\\${c}`)
      .replace(/[.,()]/g, '')

    if (!sanitizedQuery) {
      return success({
        query,
        results: { traders: [], posts: [], users: [], groups: [] },
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

    // Fetch more traders to allow relevance ranking, then trim to limit
    const traderFetchLimit = Math.max(limitPerCategory * 4, 20)

    const [tradersData, postsData, usersData, groupsData] = await Promise.all([
      safeQuery(supabase
        .from('trader_sources')
        .select('source_trader_id, handle, source')
        .or(
          `handle.ilike.%${sanitizedQuery}%,source_trader_id.ilike.%${sanitizedQuery}%`
        )
        .limit(traderFetchLimit)),

      safeQuery(supabase
        .from('posts')
        .select('id, title, author_handle, created_at, view_count')
        .or(`title.ilike.%${sanitizedQuery}%`)
        .order('view_count', { ascending: false, nullsFirst: false })
        .limit(limitPerCategory)),

      safeQuery(supabase
        .from('user_profiles')
        .select('id, handle, display_name, avatar_url, bio')
        .or(
          `handle.ilike.%${sanitizedQuery}%,display_name.ilike.%${sanitizedQuery}%,bio.ilike.%${sanitizedQuery}%`
        )
        .limit(limitPerCategory)),

      safeQuery(supabase
        .from('groups')
        .select('id, name, member_count, description')
        .ilike('name', `%${sanitizedQuery}%`)
        .limit(limitPerCategory)),
    ])

    const sourceLabels: Record<string, string> = {
      binance_futures: 'Binance',
      binance_spot: 'Binance',
      binance_web3: 'Binance',
      bybit: 'Bybit',
      bitget_futures: 'Bitget',
      bitget_spot: 'Bitget',
      mexc: 'MEXC',
      coinex: 'CoinEx',
      okx_web3: 'OKX',
      kucoin: 'KuCoin',
      gmx: 'GMX',
    }

     
    interface TraderSourceRow { source_trader_id: string; handle: string | null; source: string }
    interface PostRow { id: string; title: string | null; author_handle: string | null; created_at: string; view_count: number | null }
    interface UserRow { id: string; handle: string | null; display_name: string | null; avatar_url: string | null; bio: string | null }
    interface GroupRow { id: string; name: string; member_count: number | null; description: string | null }

    // Enrich traders with display_name and arena_score for ranking
    const tradersTyped = tradersData as TraderSourceRow[]
    const traderIds = tradersTyped.map(t => t.source_trader_id)

    // Fetch display names and arena scores in parallel
    const [lrRows, scoreRows] = await Promise.all([
      // Display names for traders without handles
      (async () => {
        const missing = tradersTyped.filter(t => !t.handle).map(t => t.source_trader_id)
        if (missing.length === 0) return []
        const { data } = await supabase
          .from('leaderboard_ranks')
          .select('source_trader_id, display_name')
          .in('source_trader_id', missing)
          .not('display_name', 'is', null)
          .limit(missing.length)
        return data || []
      })(),
      // Arena scores for relevance ranking
      (async () => {
        if (traderIds.length === 0) return []
        const { data } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id, source, arena_score')
          .in('source_trader_id', traderIds)
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .order('arena_score', { ascending: false })
          .limit(traderIds.length)
        return data || []
      })(),
    ])

    const lrNameMap = new Map<string, string>()
    for (const lr of lrRows) {
      if (lr.display_name) lrNameMap.set(lr.source_trader_id, lr.display_name)
    }

    // Build score map (source:trader_id → arena_score)
    const scoreMap = new Map<string, number>()
    for (const row of scoreRows) {
      const key = `${row.source}:${row.source_trader_id}`
      if (!scoreMap.has(key)) scoreMap.set(key, row.arena_score)
    }

    // Rank traders: exact handle match first, then by arena_score
    const queryLower = sanitizedQuery.toLowerCase()
    const rankedTraders = tradersTyped
      .map((t) => {
        const name = t.handle || lrNameMap.get(t.source_trader_id) || t.source_trader_id
        const key = `${t.source}:${t.source_trader_id}`
        const score = scoreMap.get(key) ?? 0
        const handleLower = (t.handle || '').toLowerCase()
        // Exact match gets massive boost, starts-with gets medium boost
        const exactBonus = handleLower === queryLower ? 10000 : 0
        const prefixBonus = handleLower.startsWith(queryLower) ? 1000 : 0
        return { t, name, relevance: exactBonus + prefixBonus + score }
      })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limitPerCategory)

    const traders: UnifiedSearchResult[] = rankedTraders.map(({ t, name }) => ({
      id: `${t.source}:${t.source_trader_id}`,
      type: 'trader' as const,
      title: `@${name}`,
      subtitle: sourceLabels[t.source] || t.source,
      href: `/trader/${encodeURIComponent(t.source_trader_id)}?platform=${t.source}`,
    }))

     
    const posts: UnifiedSearchResult[] = (postsData as PostRow[]).map((p) => ({
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
      results: { traders, posts, users, groups },
      total: traders.length + posts.length + users.length + groups.length,
    }

    // 缓存 5 分钟（pg_trgm索引加速后可以更长TTL）
    try {
      await cacheSet(cacheKey, result, { ttl: 300 })
    } catch {
      // 非关键
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
