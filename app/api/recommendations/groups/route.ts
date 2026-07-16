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

const DISCOVERABLE_GROUP_VISIBILITIES = ['open', 'apply'] as const

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const GROUP_DISCOVERY_SELECT =
  'id, name, name_en, description, description_en, avatar_url, member_count'

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
        // The recommendation RPC is only a ranking source. Its group IDs are
        // untrusted service-role candidates until a fresh groups-table read
        // confirms the current public-discovery state.
        const groupIds = [
          ...new Set(
            rpcData
              .map((row: Record<string, unknown>) => row.group_id)
              .filter((groupId): groupId is string => typeof groupId === 'string' && !!groupId)
          ),
        ]
        const { data: fullGroups, error: fullGroupsError } = groupIds.length
          ? await supabase
              .from('groups')
              .select(GROUP_DISCOVERY_SELECT)
              .in('id', groupIds)
              .is('dissolved_at', null)
              .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
          : { data: [], error: null }

        if (fullGroupsError) throw fullGroupsError

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
        const { data: popularData, error: popularError } = await supabase
          .from('groups')
          .select(GROUP_DISCOVERY_SELECT)
          .is('dissolved_at', null)
          .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
          .order('member_count', { ascending: false, nullsFirst: false })
          .order('id', { ascending: true })
          .limit(Math.min(50, limit + existingIds.size))

        if (popularError) throw popularError

        for (const g of (popularData as Record<string, unknown>[]) || []) {
          if (groups.length >= limit) break
          if (!existingIds.has(g.id as string)) {
            groups.push({ ...g, recommendation_reason: 'popular' })
            existingIds.add(g.id as string)
          }
        }
      }
    } else {
      // Never cache materialized group rows: dissolution, hard deletion, a
      // visibility change, or profile edits must take effect on the next read.
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('groups')
        .select(GROUP_DISCOVERY_SELECT)
        .is('dissolved_at', null)
        .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
        .order('member_count', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .limit(limit)
      if (fallbackError) throw fallbackError
      groups = (fallbackData as Record<string, unknown>[]) || []
      return success({ groups, personalized: false }, 200, NO_STORE_HEADERS)
    }

    return success({ groups, personalized: !!user }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    const response = handleError(error, 'recommendations groups GET')
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      response.headers.set(name, value)
    }
    return response
  }
}
