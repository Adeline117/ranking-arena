/**
 * Public collections for a user profile
 * GET /api/users/[handle]/collections
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  success,
  handleError,
} from '@/lib/api'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const supabase = getSupabaseAdmin()

    // Find user by handle
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', decodeURIComponent(handle))
      .single()

    if (!profile) {
      return success({ collections: [] })
    }

    const { data: collections, error } = await supabase
      .from('user_collections')
      .select('*, collection_items(count)')
      .eq('user_id', profile.id)
      .eq('is_public', true)
      .order('created_at', { ascending: true })

    if (error) throw error

    const result = (collections || []).map((c: Record<string, unknown>) => ({
      ...c,
      item_count: Array.isArray(c.collection_items) ? (c.collection_items[0] as Record<string, number>)?.count || 0 : 0,
      collection_items: undefined,
    }))

    return success({ collections: result })
  } catch (error: unknown) {
    return handleError(error, 'user-collections GET')
  }
}
