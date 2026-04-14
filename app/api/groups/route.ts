import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getOrSetWithLock } from '@/lib/cache'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'

/**
 * GET /api/groups
 * 获取小组列表，支持排序和分页
 *
 * Query params:
 * - sort_by: 'activity' | 'member_count' | 'created_at' (default: 'member_count')
 * - limit: number (default: 10, max: 50)
 * - offset: number (default: 0)
 */
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const { searchParams } = new URL(request.url)
    const _sortBy = searchParams.get('sort_by') || 'member_count'
    const limit = parseLimit(searchParams.get('limit'), 10, 50)
    const offset = parseOffset(searchParams.get('offset'))

    const cacheKey = `api:groups:${_sortBy}:${limit}:${offset}`

    const result = await getOrSetWithLock(
      cacheKey,
      async () => {
        const supabase = getSupabaseAdmin()

        // Run data + count queries in parallel
        const [dataResult, countResult] = await Promise.all([
          supabase
            .from('groups')
            .select(`id, name, name_en, description, avatar_url, member_count`)
            .order('member_count', { ascending: false, nullsFirst: false })
            .range(offset, offset + limit - 1),
          // KEEP 'exact' — groups list pagination "X of Y"; groups
          // table is small (~hundreds) so count is fast.
          supabase
            .from('groups')
            .select('id', { count: 'exact', head: true }),
        ])

        if (dataResult.error) {
          throw dataResult.error
        }

        return {
          success: true,
          data: {
            groups: dataResult.data || [],
            pagination: {
              limit,
              offset,
              total: countResult.count || 0,
              has_more: (offset + limit) < (countResult.count || 0),
            },
          },
        }
      },
      { ttl: 300, lockTtl: 10 }
    )

    const response = NextResponse.json(result)
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return response
  } catch (error: unknown) {
    logger.apiError('/api/groups', error, {})
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
