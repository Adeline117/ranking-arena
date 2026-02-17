/**
 * GET /api/recommendations/groups
 *
 * Recommends groups for the authenticated user via recommend_groups_for_user RPC.
 * Falls back to member_count ordering for unauthenticated users.
 */

export const runtime = 'edge'

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

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 10

    const user = await getAuthUser(request)

    let groups: Record<string, unknown>[] = []

    if (user) {
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        'recommend_groups_for_user',
        { p_user_id: user.id, p_limit: limit }
      )

      if (!rpcError && rpcData && Array.isArray(rpcData) && rpcData.length > 0) {
        // RPC returns group_id + reason/score; fetch full group data
        const groupIds = rpcData.map((r: Record<string, unknown>) => r.group_id as string)
        const { data: fullGroups } = await supabase
          .from('groups')
          .select('id, name, name_en, description, description_en, avatar_url, member_count')
          .in('id', groupIds)

        const groupMap = new Map((fullGroups || []).map((g: Record<string, unknown>) => [g.id, g]))

        groups = rpcData.map((r: Record<string, unknown>) => ({
          ...(groupMap.get(r.group_id as string) || {}),
          recommendation_reason: r.reason || null,
          recommendation_score: r.score || null,
        })).filter((g: Record<string, unknown>) => g.id)
      } else {
        // RPC failed or empty — fallback
        const { data: fallbackData } = await supabase
          .from('groups')
          .select('id, name, name_en, description, description_en, avatar_url, member_count')
          .order('member_count', { ascending: false })
          .limit(limit)

        groups = (fallbackData as Record<string, unknown>[]) || []
      }
    } else {
      // Unauthenticated fallback
      const { data: fallbackData } = await supabase
        .from('groups')
        .select('id, name, name_en, description, description_en, avatar_url, member_count')
        .order('member_count', { ascending: false })
        .limit(limit)

      groups = (fallbackData as Record<string, unknown>[]) || []
    }

    return success({ groups, personalized: !!user })
  } catch (error: unknown) {
    return handleError(error, 'recommendations groups GET')
  }
}
