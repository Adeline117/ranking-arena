/**
 * Single Collection API
 * GET /api/collections/[id] - Get collection details with items
 * PATCH /api/collections/[id] - Update collection
 * DELETE /api/collections/[id] - Delete collection
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  getAuthUser,
  success,
  handleError,
  validateString,
  validateBoolean,
  validateUUID,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'
import { readPublicProfileAudienceById } from '@/lib/profile/public-audience'
import {
  filterServiceReadableCollectionItems,
  rebindServiceReadableCollectionItems,
} from '@/lib/collections/public-audience'
import { parseCollectionMutationAck } from '@/lib/collections/atomic'
import type { Database } from '@/lib/supabase/database.types'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const
const DEFAULT_COLLECTION_ITEM_PAGE_SIZE = 50
const MAX_COLLECTION_ITEM_PAGE_SIZE = 100

type CollectionCandidate = Database['public']['Tables']['user_collections']['Row']

function noStore<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value)
  return response
}

async function readCollectionCandidate(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  collectionId: string
): Promise<CollectionCandidate | null> {
  const { data, error } = await supabase
    .from('user_collections')
    .select('id, user_id, name, description, is_public, created_at, updated_at')
    .eq('id', collectionId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function canReadCollection(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  collection: CollectionCandidate,
  actorId: string | null
): Promise<boolean> {
  const isOwner = collection.user_id === actorId
  if (!isOwner && collection.is_public !== true) return false

  // Owners also pass through the uncached current-state decision. Otherwise a
  // deleted or actively banned owner could keep reading through a recently
  // cached authentication result.
  const ownerAudience = await readPublicProfileAudienceById(supabase, collection.user_id)
  return ownerAudience.status === 'active'
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: requestedId } = await params
    const id = validateUUID(requestedId, { required: true, fieldName: 'collection id' })!
    const supabase = getSupabaseAdmin()
    const user = await getAuthUser(request)
    const limit = parseLimit(
      request.nextUrl.searchParams.get('limit'),
      DEFAULT_COLLECTION_ITEM_PAGE_SIZE,
      MAX_COLLECTION_ITEM_PAGE_SIZE
    )
    const offset = parseOffset(request.nextUrl.searchParams.get('offset'))
    const collection = await readCollectionCandidate(supabase, id)

    if (!collection || !(await canReadCollection(supabase, collection, user?.id ?? null))) {
      return success({ error: 'Collection not found' }, 404, NO_STORE_HEADERS)
    }

    const { data: itemCandidates, error: itemsError } = await supabase
      .from('collection_items')
      .select('id, collection_id, item_id, item_type, note, added_at')
      .eq('collection_id', id)
      .order('added_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit)

    if (itemsError) throw itemsError
    const itemPageCandidates = (itemCandidates || []).slice(0, limit)
    const audienceApprovedItems = await filterServiceReadableCollectionItems(
      supabase,
      itemPageCandidates,
      user?.id ?? null
    )

    // The service client bypasses RLS. Re-materialize audience-approved child
    // rows so deletion, movement, retargeting, or a note update during the
    // audience calls cannot release the stale candidate snapshot.
    let items: typeof itemPageCandidates = []
    if (audienceApprovedItems.length > 0) {
      const { data: currentItems, error: currentItemsError } = await supabase
        .from('collection_items')
        .select('id, collection_id, item_id, item_type, note, added_at')
        .eq('collection_id', id)
        .in(
          'id',
          audienceApprovedItems.map((item) => item.id)
        )
        .limit(limit)

      if (currentItemsError) throw currentItemsError
      items = rebindServiceReadableCollectionItems(audienceApprovedItems, currentItems || [])
    }

    // Re-materialize and re-authorize the container after all child reads so a
    // privacy/account-state transition cannot release rows authorized only
    // against the earlier snapshot.
    const currentCollection = await readCollectionCandidate(supabase, id)
    if (
      !currentCollection ||
      !(await canReadCollection(supabase, currentCollection, user?.id ?? null))
    ) {
      return success({ error: 'Collection not found' }, 404, NO_STORE_HEADERS)
    }

    return success(
      {
        collection: currentCollection,
        items,
        pagination: {
          limit,
          offset,
          has_more: (itemCandidates?.length || 0) > limit,
        },
      },
      200,
      NO_STORE_HEADERS
    )
  } catch (error: unknown) {
    return noStore(handleError(error, 'collection GET'))
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return noStore(rateLimitResp)

  try {
    const { id: requestedId } = await params
    const id = validateUUID(requestedId, { required: true, fieldName: 'collection id' })!
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = (await request.json()) as Record<string, unknown>
    const namePresent = body.name !== undefined
    const descriptionPresent = body.description !== undefined
    const isPublicPresent = body.is_public !== undefined
    const name = namePresent
      ? validateString(body.name, {
          required: true,
          minLength: 1,
          maxLength: 50,
          fieldName: 'name',
        })
      : null
    const description = descriptionPresent
      ? validateString(body.description, { maxLength: 200, fieldName: 'description' })
      : null
    const isPublic = isPublicPresent
      ? validateBoolean(body.is_public, { required: true, fieldName: 'is_public' })
      : null

    const { data, error } = await supabase.rpc('mutate_user_collection_atomic', {
      p_action: 'update',
      p_actor_id: user.id,
      p_collection_id: id,
      p_description: description,
      p_description_present: descriptionPresent,
      p_is_public: isPublic,
      p_is_public_present: isPublicPresent,
      p_name: name,
      p_name_present: namePresent,
    })

    if (error) throw error
    const acknowledgement = parseCollectionMutationAck(data, {
      action: 'update',
      actorId: user.id,
      collectionId: id,
    })
    if (acknowledgement.result_code === 'not_found') {
      return success({ error: 'Collection not found' }, 404, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'already_exists') {
      return success({ error: 'Collection with this name already exists' }, 409, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
    }
    return success({ collection: acknowledgement.collection }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    return noStore(handleError(error, 'collection PATCH'))
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

    const { data, error } = await supabase.rpc('mutate_user_collection_atomic', {
      p_action: 'delete',
      p_actor_id: user.id,
      p_collection_id: id,
      p_description: null,
      p_description_present: false,
      p_is_public: null,
      p_is_public_present: false,
      p_name: null,
      p_name_present: false,
    })

    if (error) throw error
    const acknowledgement = parseCollectionMutationAck(data, {
      action: 'delete',
      actorId: user.id,
      collectionId: id,
    })
    if (acknowledgement.result_code === 'not_found') {
      // Preserve the historical idempotent DELETE contract without revealing
      // whether the requested id belongs to another account.
      return success({ deleted: true }, 200, NO_STORE_HEADERS)
    }
    if (acknowledgement.result_code === 'inactive_actor') {
      return success({ error: 'Account is not active' }, 403, NO_STORE_HEADERS)
    }
    return success({ deleted: true }, 200, NO_STORE_HEADERS)
  } catch (error: unknown) {
    return noStore(handleError(error, 'collection DELETE'))
  }
}
