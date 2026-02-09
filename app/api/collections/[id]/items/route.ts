/**
 * Collection Items API
 * POST /api/collections/[id]/items - Add item to collection
 * DELETE /api/collections/[id]/items - Remove item from collection
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
} from '@/lib/api'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Verify ownership
    const { data: collection } = await supabase
      .from('user_collections')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (!collection) {
      return success({ error: 'Collection not found' }, 404)
    }

    const body = await request.json()
    const item_type = validateString(body.item_type, { required: true, fieldName: 'item_type' })!
    const item_id = validateString(body.item_id, { required: true, fieldName: 'item_id' })!
    const note = validateString(body.note, { maxLength: 500 })

    if (!['trader', 'book', 'post'].includes(item_type)) {
      return success({ error: 'Invalid item_type' }, 400)
    }

    const { data: item, error } = await supabase
      .from('collection_items')
      .insert({ collection_id: id, item_type, item_id, note })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return success({ error: 'Item already in collection' }, 409)
      }
      throw error
    }

    return success({ item })
  } catch (error: unknown) {
    return handleError(error, 'collection-items POST')
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

    // Verify ownership
    const { data: collection } = await supabase
      .from('user_collections')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (!collection) {
      return success({ error: 'Collection not found' }, 404)
    }

    const { searchParams } = new URL(request.url)
    const item_type = searchParams.get('item_type')
    const item_id = searchParams.get('item_id')

    if (!item_type || !item_id) {
      return success({ error: 'item_type and item_id required' }, 400)
    }

    const { error } = await supabase
      .from('collection_items')
      .delete()
      .eq('collection_id', id)
      .eq('item_type', item_type)
      .eq('item_id', item_id)

    if (error) throw error
    return success({ removed: true })
  } catch (error: unknown) {
    return handleError(error, 'collection-items DELETE')
  }
}
