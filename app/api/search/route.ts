/**
 * 统一搜索 API
 * 聚合搜索交易员、帖子、资料库、用户，按类别返回结果
 */

import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'

export const dynamic = 'force-dynamic'

export interface UnifiedSearchResult {
  id: string
  type: 'trader' | 'post' | 'library' | 'user'
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
        results: { traders: [], posts: [], library: [], users: [] },
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
        results: { traders: [], posts: [], library: [], users: [] },
        total: 0,
      } satisfies UnifiedSearchResponse)
    }

    // 并行查询所有表
    const [tradersRes, postsRes, libraryRes, usersRes] = await Promise.all([
      // 交易员
      supabase
        .from('trader_sources')
        .select('source_trader_id, handle, source')
        .or(
          `handle.ilike.%${sanitizedQuery}%,source_trader_id.ilike.%${sanitizedQuery}%`
        )
        .limit(limitPerCategory),

      // 帖子
      supabase
        .from('posts')
        .select('id, title, author_handle, created_at, view_count')
        .or(`title.ilike.%${sanitizedQuery}%`)
        .order('view_count', { ascending: false, nullsFirst: false })
        .limit(limitPerCategory),

      // 资料库
      supabase
        .from('library_items')
        .select('id, title, author, slug, category')
        .or(
          `title.ilike.%${sanitizedQuery}%,author.ilike.%${sanitizedQuery}%`
        )
        .limit(limitPerCategory),

      // 用户
      supabase
        .from('user_profiles')
        .select('id, handle, display_name, avatar_url, bio')
        .or(
          `handle.ilike.%${sanitizedQuery}%,display_name.ilike.%${sanitizedQuery}%,bio.ilike.%${sanitizedQuery}%`
        )
        .limit(limitPerCategory),
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

    const traders: UnifiedSearchResult[] = (tradersRes.data ?? []).map((t) => ({
      id: `${t.source}:${t.source_trader_id}`,
      type: 'trader' as const,
      title: `@${t.handle || t.source_trader_id}`,
      subtitle: sourceLabels[t.source] || t.source,
      href: `/trader/${encodeURIComponent(t.handle || t.source_trader_id)}`,
    }))

    const posts: UnifiedSearchResult[] = (postsRes.data ?? []).map((p) => ({
      id: p.id,
      type: 'post' as const,
      title: p.title || '无标题',
      subtitle: p.author_handle ? `@${p.author_handle}` : undefined,
      href: `/post/${p.id}`,
      meta: { view_count: p.view_count },
    }))

    const library: UnifiedSearchResult[] = (libraryRes.data ?? []).map(
      (l) => ({
        id: l.id,
        type: 'library' as const,
        title: l.title,
        subtitle: l.author || l.category || undefined,
        href: `/library/${l.slug || l.id}`,
      })
    )

    const users: UnifiedSearchResult[] = (usersRes.data ?? []).map((u) => ({
      id: u.id,
      type: 'user' as const,
      title: u.display_name || `@${u.handle}`,
      subtitle: u.handle ? `@${u.handle}` : undefined,
      href: `/u/${encodeURIComponent(u.handle || u.id)}`,
      avatar: u.avatar_url,
    }))

    const result: UnifiedSearchResponse = {
      query,
      results: { traders, posts, library, users },
      total: traders.length + posts.length + library.length + users.length,
    }

    // 缓存 30 秒
    try {
      await cacheSet(cacheKey, result, { ttl: 120 })
    } catch {
      // 非关键
    }

    // 搜索分析（异步）
    void Promise.resolve(
      supabase.from('search_analytics').insert({
        query: query.slice(0, 200),
        result_count: result.total,
        source: 'unified',
      })
    ).catch(() => {})

    return success(result, 200, {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
    })
  },
  { name: 'unified-search', rateLimit: 'read' }
)
