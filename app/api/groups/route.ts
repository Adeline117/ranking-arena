import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const DISCOVERABLE_GROUP_VISIBILITIES = ['open', 'apply'] as const

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

type GroupSort = 'activity' | 'member_count' | 'created_at'

function parseGroupSort(value: string | null): GroupSort {
  if (value === 'activity' || value === 'created_at') return value
  return 'member_count'
}

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

  const rateLimitResult = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResult) return rateLimitResult

  try {
    const { searchParams } = new URL(request.url)
    const sortBy = parseGroupSort(searchParams.get('sort_by'))
    const limit = parseLimit(searchParams.get('limit'), 10, 50)
    const offset = parseOffset(searchParams.get('offset'))
    const orderColumn =
      sortBy === 'activity' ? 'updated_at' : sortBy === 'created_at' ? 'created_at' : 'member_count'
    const supabase = getSupabaseAdmin()

    // The admin client bypasses groups RLS. Read the current public-discovery
    // subset on every request so a dissolved/deleted group (or a future private
    // group) cannot survive in a response cache. The table is intentionally
    // small, so a fresh bounded page + exact count is the safer trade-off.
    const [dataResult, countResult] = await Promise.all([
      supabase
        .from('groups')
        .select('id, name, name_en, description, avatar_url, member_count')
        .is('dissolved_at', null)
        .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
        .order(orderColumn, { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1),
      // KEEP 'exact' — groups list pagination "X of Y"; groups
      // table is small (~hundreds) so count is fast.
      supabase
        .from('groups')
        .select('id', { count: 'exact', head: true })
        .is('dissolved_at', null)
        .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES]),
    ])

    if (dataResult.error) throw dataResult.error
    if (countResult.error) throw countResult.error

    const total = countResult.count ?? 0
    return NextResponse.json(
      {
        success: true,
        data: {
          groups: dataResult.data ?? [],
          pagination: {
            limit,
            offset,
            total,
            has_more: offset + limit < total,
          },
        },
      },
      { headers: NO_STORE_HEADERS }
    )
  } catch (error: unknown) {
    logger.apiError('/api/groups', error, {})
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500, headers: NO_STORE_HEADERS }
    )
  }
}
