/**
 * 统一搜索 API
 * 聚合搜索交易员、帖子、资料库、用户，按类别返回结果
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
      // 缓存未命中
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
