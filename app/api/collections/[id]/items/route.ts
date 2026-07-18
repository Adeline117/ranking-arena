/**
 * Collection Items API
 * POST /api/collections/[id]/items - Add item to collection
 * DELETE /api/collections/[id]/items - Remove item from collection
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateEnum,
  validateUUID,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { parseCollectionItemMutationAck } from '@/lib/collections/atomic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const ITEM_TYPES = ['post', 'activity'] as const

function noStore<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value)
  return response
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return noStore(rateLimitResp)

  try {
    const { id: requestedId } = await params
    const id = validateUUID(requestedId, { required: true, fieldName: 'collection id' })!
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = (await request.json()) as Record<string, unknown>
    const item_type = validateEnum(body.item_type, ITEM_TYPES, {
      required: true,
      fieldName: 'item_type',
    })!
    const item_id = validateUUID(body.item_id, { required: true, fieldName: 'item_id' })!
    const note = validateString(body.note, { maxLength: 500, fieldName: 'note' })

    const { data, error } = await supabase.rpc('mutate_collection_item_atomic', {
      p_action: 'add',
      p_actor_id: user.id,
      p_collection_id: id,
      p_item_id: item_id,
      p_item_type: item_type,
      p_note: note,
    })

    if (error) throw error
    const acknowledgement = parseCollectionItemMutationAck(data, {
      action: 'add',
      actorId: user.id,
      collectionId: id,
      itemId: item_id,
      itemType: item_type,
    })
    if (acknowledgement.result_code === 'already_exists') {
      return success({ error: 'Item already in collection' }, 409, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'collection_not_found') {
      return success({ error: 'Collection not found' }, 404, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'resource_not_found') {
      return success({ error: 'Collection item not found' }, 404, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
    }

    return success({ item: acknowledgement.item }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    return noStore(handleError(error, 'collection-items POST'))
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return noStore(rateLimitResp)

  try {
    const { id: requestedId } = await params
    const id = validateUUID(requestedId, { required: true, fieldName: 'collection id' })!
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { searchParams } = new URL(request.url)
    const item_type = validateEnum(searchParams.get('item_type'), ITEM_TYPES, {
      required: true,
      fieldName: 'item_type',
    })!
    const item_id = validateUUID(searchParams.get('item_id'), {
      required: true,
      fieldName: 'item_id',
    })!

    const { data, error } = await supabase.rpc('mutate_collection_item_atomic', {
      p_action: 'remove',
      p_actor_id: user.id,
      p_collection_id: id,
      p_item_id: item_id,
      p_item_type: item_type,
      p_note: null,
    })

    if (error) throw error
    const acknowledgement = parseCollectionItemMutationAck(data, {
      action: 'remove',
      actorId: user.id,
      collectionId: id,
      itemId: item_id,
      itemType: item_type,
    })
    if (acknowledgement.result_code === 'collection_not_found') {
      return success({ error: 'Collection not found' }, 404, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'not_found') {
      // Preserve the endpoint's historical idempotence: deleting an item that
      // is already absent succeeds as long as the owned collection still exists.
      return success({ removed: true }, 200, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
    }
    return success({ removed: true }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    return noStore(handleError(error, 'collection-items DELETE'))
  }
}
