/**
 * GET /api/recommendations/groups
 *
 * Recommends groups for the authenticated user via recommend_groups_for_user RPC.
 * Falls back to member_count ordering for unauthenticated users.
 */

export const runtime = 'nodejs'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  validateNumber,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { socialFeatureGuard } from '@/lib/features'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

// 未登录 fallback 对全体匿名一致(popular groups),此前每请求裸打 DB。
const ANON_CACHE_HEADER = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' }

export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 10

    const user = await getAuthUser(request)

    let groups: Record<string, unknown>[] = []

    if (user) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('recommend_groups_for_user', {
        p_user_id: user.id,
        p_limit: limit,
      })

      if (!rpcError && rpcData && Array.isArray(rpcData) && rpcData.length > 0) {
        // RPC returns group_id + reason/score; fetch full group data
        const groupIds = rpcData.map((r: Record<string, unknown>) => r.group_id as string)
        const { data: fullGroups } = await supabase
          .from('groups')
          .select('id, name, name_en, description, description_en, avatar_url, member_count')
          .in('id', groupIds)

        const groupMap = new Map((fullGroups || []).map((g: Record<string, unknown>) => [g.id, g]))

        groups = rpcData
          .map((r: Record<string, unknown>) => ({
            ...(groupMap.get(r.group_id as string) || {}),
            recommendation_reason: r.reason || null,
            recommendation_score: r.score || null,
          }))
          .filter((g: Record<string, unknown>) => g.id)
      }

      // If fewer than 3 personalized results, pad with popular groups
      // (handles case where user has joined nearly all groups)
      if (groups.length < Math.min(3, limit)) {
        const existingIds = new Set(groups.map((g: Record<string, unknown>) => g.id as string))
        const { data: popularData } = await supabase
          .from('groups')
          .select('id, name, name_en, description, description_en, avatar_url, member_count')
          .order('member_count', { ascending: false })
          .limit(limit)

        for (const g of (popularData as Record<string, unknown>[]) || []) {
          if (groups.length >= limit) break
          if (!existingIds.has(g.id as string)) {
            groups.push({ ...g, recommendation_reason: 'popular' })
            existingIds.add(g.id as string)
          }
        }
      }
    } else {
      // Unauthenticated fallback — popular groups, 全体匿名共享,Redis 缓存 5min。
      groups = await tieredGetOrSet(
        `rec:groups:anon:${limit}`,
        async () => {
          const { data: fallbackData } = await supabase
            .from('groups')
            .select('id, name, name_en, description, description_en, avatar_url, member_count')
            .order('member_count', { ascending: false })
            .limit(limit)
          return (fallbackData as Record<string, unknown>[]) || []
        },
        'cold'
      )
      return success({ groups, personalized: false }, 200, ANON_CACHE_HEADER)
    }

    return success({ groups, personalized: !!user })
  } catch (error: unknown) {
    return handleError(error, 'recommendations groups GET')
  }
}
