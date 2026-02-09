/**
 * Collections API
 * GET /api/collections - Get current user's collections
 * POST /api/collections - Create a new collection
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateBoolean,
} from '@/lib/api'

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Ensure default collections exist
    try { await supabase.rpc('ensure_default_collections', { p_user_id: user.id }) } catch { /* ignore */ }

    const { data: collections, error } = await supabase
      .from('user_collections')
      .select('*, collection_items(count)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) throw error

    const result = (collections || []).map((c: Record<string, unknown>) => ({
      ...c,
      item_count: Array.isArray(c.collection_items) ? (c.collection_items[0] as Record<string, number>)?.count || 0 : 0,
      collection_items: undefined,
    }))

    return success({ collections: result })
  } catch (error: unknown) {
    return handleError(error, 'collections GET')
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const name = validateString(body.name, { required: true, minLength: 1, maxLength: 50, fieldName: 'name' })!
    const description = validateString(body.description, { maxLength: 200 })
    const is_public = validateBoolean(body.is_public) ?? false

    const { data: collection, error } = await supabase
      .from('user_collections')
      .insert({ user_id: user.id, name, description, is_public })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return success({ error: 'Collection with this name already exists' }, 409)
      }
      throw error
    }

    return success({ collection })
  } catch (error: unknown) {
    return handleError(error, 'collections POST')
  }
}
