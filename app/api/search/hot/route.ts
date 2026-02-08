/**
 * 热门搜索 API
 * 从 posts 表获取 hot_score 排名前 5 的帖子关键词
 * Redis 缓存 5 分钟
 */

import { withPublic } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'

export const dynamic = 'force-dynamic'

interface HotSearchItem {
  keyword: string
  count: number
  trend: 'up' | 'down' | 'stable'
}

const CACHE_KEY = 'search:hot:v1'
const CACHE_TTL = 300 // 5 minutes

export const GET = withPublic(
  async ({ supabase }) => {
    // Try cache first
    const cached = await cacheGet<HotSearchItem[]>(CACHE_KEY)
    if (cached) {
      return success({ hotSearches: cached }, 200, {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      })
    }

    // Query top posts by hot_score for keywords
    const { data: hotPosts } = await supabase
      .from('posts')
      .select('title, hot_score, view_count, like_count, comment_count')
      .not('title', 'is', null)
      .order('hot_score', { ascending: false, nullsFirst: false })
      .limit(20)

    const hotSearches: HotSearchItem[] = []
    const seenKeywords = new Set<string>()

    if (hotPosts && hotPosts.length > 0) {
      for (const post of hotPosts) {
        if (hotSearches.length >= 5) break
        if (!post.title) continue

        // Extract meaningful keyword from title (first significant word/phrase)
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

    // Fallback if no hot posts found
    if (hotSearches.length === 0) {
      hotSearches.push(
        { keyword: 'BTC', count: 1000, trend: 'up' },
        { keyword: 'ETH', count: 800, trend: 'up' },
        { keyword: 'SOL', count: 500, trend: 'stable' },
      )
    }

    // Cache result
    await cacheSet(CACHE_KEY, hotSearches, { ttl: CACHE_TTL })

    return success({ hotSearches }, 200, {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    })
  }
)

/**
 * Extract a meaningful keyword from a post title
 * Prioritizes: crypto symbols ($BTC), hashtags, or first meaningful phrase
 */
function extractKeyword(title: string): string | null {
  if (!title || title.length < 2) return null

  // Match crypto symbols like $BTC, $ETH
  const symbolMatch = title.match(/\$([A-Z]{2,10})/i)
  if (symbolMatch) return symbolMatch[1].toUpperCase()

  // Match hashtags
  const hashMatch = title.match(/#(\S{2,20})/)
  if (hashMatch) return hashMatch[1]

  // Remove common stop words and get first meaningful phrase
  const cleaned = title
    .replace(/[【】\[\]()（）「」《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Take first meaningful segment (up to 10 chars)
  const words = cleaned.split(/\s+/).filter(w => w.length >= 2)
  if (words.length === 0) return null

  // Return first 1-3 words, max 12 chars
  let result = ''
  for (const word of words) {
    if ((result + ' ' + word).trim().length > 12) break
    result = (result + ' ' + word).trim()
  }

  return result || null
}
