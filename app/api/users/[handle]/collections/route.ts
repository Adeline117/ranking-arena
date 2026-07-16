/**
 * Public collections for a user profile
 * GET /api/users/[handle]/collections
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin, success, handleError, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
    if (rateLimitResponse) return rateLimitResponse

    const { handle } = await params
    const supabase = getSupabaseAdmin()
    const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }

    let decodedHandle: string
    try {
      decodedHandle = decodeURIComponent(handle)
    } catch {
      return success({ collections: [] }, 400, noStore)
    }

    const audience = await readPublicProfileAudienceByHandle(supabase, decodedHandle)

    if (audience.status !== 'active') {
      return success({ collections: [] }, 404, noStore)
    }

    const { data: collections, error } = await supabase
      .from('user_collections')
      .select('id, name, description, is_public, created_at, updated_at, collection_items(count)')
      .eq('user_id', audience.profile.id)
      .eq('is_public', true)
      .order('created_at', { ascending: true })

    if (error) throw error

    const result = (collections || []).map((c: Record<string, unknown>) => ({
      ...c,
      item_count: Array.isArray(c.collection_items)
        ? (c.collection_items[0] as Record<string, number>)?.count || 0
        : 0,
      collection_items: undefined,
    }))

    return success({ collections: result }, 200, noStore)
  } catch (error: unknown) {
    return handleError(error, 'user-collections GET')
  }
}
