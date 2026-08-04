/**
 * Collection Items API
 * POST /api/collections/[id]/items - Add item to collection
 * DELETE /api/collections/[id]/items - Remove item from collection
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  ApiError,
  conflict,
  forbidden,
  getSupabaseAdmin,
  notFound,
  requireAuth,
  success,
  handleError,
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AddCollectionItemSchema = z
  .object({
    item_type: z.enum(ITEM_TYPES),
    item_id: z
      .string()
      .trim()
      .regex(UUID_PATTERN)
      .transform((value) => value.toLowerCase()),
    note: z
      .string()
      .max(500)
      .transform((value) => value.trim() || null)
      .nullable()
      .optional(),
  })
  .strict()

function noStore<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value)
  return response
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return noStore(rateLimitResp)

  try {
    const { id: requestedId } = await params
    const id = validateUUID(requestedId, {
      required: true,
      fieldName: 'collection id',
    })!.toLowerCase()
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw ApiError.validation('Invalid JSON body')
    }
    const parsed = AddCollectionItemSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const { item_type, item_id } = parsed.data
    const note = parsed.data.note ?? null

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
      return noStore(conflict('Item already in collection'))
    }
    if (acknowledgement.result_code === 'collection_not_found') {
      return noStore(notFound('Collection not found'))
    }
    if (acknowledgement.result_code === 'resource_not_found') {
      return noStore(notFound('Collection item not found'))
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return noStore(forbidden('Account is not active'))
    }
    if (!acknowledgement.item) throw new Error('Missing inserted collection item')

    return success(
      {
        action: 'add' as const,
        actorId: user.id,
        collectionId: id,
        itemId: item_id,
        itemType: item_type,
        item: acknowledgement.item,
      },
      200,
      NO_STORE_HEADERS
    )
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
      return noStore(notFound('Collection not found'))
    }
    if (acknowledgement.result_code === 'not_found') {
      // Preserve the endpoint's historical idempotence: deleting an item that
      // is already absent succeeds as long as the owned collection still exists.
      return success({ removed: true }, 200, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return noStore(forbidden('Account is not active'))
    }
    return success({ removed: true }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    return noStore(handleError(error, 'collection-items DELETE'))
  }
}
