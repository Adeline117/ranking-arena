/**
 * Single Collection API
 * GET /api/collections/[id] - Get collection details with items
 * PATCH /api/collections/[id] - Update collection
 * DELETE /api/collections/[id] - Delete collection
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  getUserFromToken,
  success,
  handleError,
  validateString,
  validateBoolean,
} from '@/lib/api'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = getSupabaseAdmin()
    const token = request.headers.get('authorization')?.substring(7) || ''
    const user = await getUserFromToken(token).catch(() => null)

    const { data: collection, error } = await supabase
      .from('user_collections')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !collection) {
      return success({ error: 'Collection not found' }, 404)
    }

    // Check access
    if (!collection.is_public && collection.user_id !== user?.id) {
      return success({ error: 'Not found' }, 404)
    }

    // Get items
    const { data: items } = await supabase
      .from('collection_items')
      .select('*')
      .eq('collection_id', id)
      .order('added_at', { ascending: false })

    return success({ collection, items: items || [] })
  } catch (error: unknown) {
    return handleError(error, 'collection GET')
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.name !== undefined) updates.name = validateString(body.name, { required: true, minLength: 1, maxLength: 50, fieldName: 'name' })
    if (body.description !== undefined) updates.description = validateString(body.description, { maxLength: 200 })
    if (body.is_public !== undefined) updates.is_public = validateBoolean(body.is_public)

    const { data, error } = await supabase
      .from('user_collections')
      .update(updates)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single()

    if (error) throw error
    return success({ collection: data })
  } catch (error: unknown) {
    return handleError(error, 'collection PATCH')
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { error } = await supabase
      .from('user_collections')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) throw error
    return success({ deleted: true })
  } catch (error: unknown) {
    return handleError(error, 'collection DELETE')
  }
}
