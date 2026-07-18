/**
 * Public collections for a user profile
 * GET /api/users/[handle]/collections
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'
import {
  filterServiceReadableCollectionItems,
  MAX_COLLECTION_AUDIENCE_ITEMS,
  rebindServiceReadableCollectionItems,
} from '@/lib/collections/public-audience'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const
const DEFAULT_PUBLIC_COLLECTION_PAGE_SIZE = 25
const MAX_PUBLIC_COLLECTION_PAGE_SIZE = 50

function noStore<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value)
  return response
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
    if (rateLimitResponse) return noStore(rateLimitResponse)

    const { handle } = await params
    const supabase = getSupabaseAdmin()
    const actor = await getAuthUser(request)
    const limit = parseLimit(
      request.nextUrl.searchParams.get('limit'),
      DEFAULT_PUBLIC_COLLECTION_PAGE_SIZE,
      MAX_PUBLIC_COLLECTION_PAGE_SIZE
    )
    const offset = parseOffset(request.nextUrl.searchParams.get('offset'))

    let decodedHandle: string
    try {
      decodedHandle = decodeURIComponent(handle)
    } catch {
      return success({ collections: [] }, 400, NO_STORE_HEADERS)
    }

    const audience = await readPublicProfileAudienceByHandle(supabase, decodedHandle)

    if (audience.status !== 'active') {
      return success({ collections: [] }, 404, NO_STORE_HEADERS)
    }

    const { data: collections, error } = await supabase
      .from('user_collections')
      .select('id, name, description, is_public, created_at, updated_at')
      .eq('user_id', audience.profile.id)
      .eq('is_public', true)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + limit)

    if (error) throw error

    const collectionPageCandidates = (collections || []).slice(0, limit)
    const collectionIds = collectionPageCandidates.map((collection) => collection.id)
    let itemCandidatesWereTruncated = false
    let audienceApprovedItems: Array<{
      id: string
      collection_id: string
      item_id: string
      item_type: string
    }> = []
    if (collectionIds.length > 0) {
      const { data: itemCandidates, error: itemsError } = await supabase
        .from('collection_items')
        .select('id, collection_id, item_id, item_type')
        .in('collection_id', collectionIds)
        .order('id', { ascending: true })
        .limit(MAX_COLLECTION_AUDIENCE_ITEMS + 1)

      if (itemsError) throw itemsError
      itemCandidatesWereTruncated = (itemCandidates?.length || 0) > MAX_COLLECTION_AUDIENCE_ITEMS
      audienceApprovedItems = await filterServiceReadableCollectionItems(
        supabase,
        (itemCandidates || []).slice(0, MAX_COLLECTION_AUDIENCE_ITEMS),
        actor?.id ?? null
      )
    }

    // Rebind approved identities to current rows. A deleted, moved, or
    // retargeted child must not survive as a stale count after audience checks.
    let readableItems = audienceApprovedItems
    if (audienceApprovedItems.length > 0) {
      const { data: currentItems, error: currentItemsError } = await supabase
        .from('collection_items')
        .select('id, collection_id, item_id, item_type')
        .in('collection_id', collectionIds)
        .in(
          'id',
          audienceApprovedItems.map((item) => item.id)
        )
        .limit(MAX_COLLECTION_AUDIENCE_ITEMS)

      if (currentItemsError) throw currentItemsError
      readableItems = rebindServiceReadableCollectionItems(
        audienceApprovedItems,
        currentItems || []
      )
    }

    const itemCountByCollection = new Map<string, number>()
    for (const item of readableItems) {
      itemCountByCollection.set(
        item.collection_id,
        (itemCountByCollection.get(item.collection_id) || 0) + 1
      )
    }

    // Re-read the selected containers after every child operation and rebuild
    // the response exclusively from current public rows. A public-to-private
    // transition or deletion therefore drops both metadata and item counts.
    let currentCollections: typeof collectionPageCandidates = []
    if (collectionIds.length > 0) {
      const { data, error: currentCollectionsError } = await supabase
        .from('user_collections')
        .select('id, name, description, is_public, created_at, updated_at')
        .eq('user_id', audience.profile.id)
        .eq('is_public', true)
        .in('id', collectionIds)
        .limit(limit)

      if (currentCollectionsError) throw currentCollectionsError
      currentCollections = data || []
    }

    // Handles can be renamed and reassigned. Resolve the same handle again
    // after every service-role read and require it to remain bound to the
    // immutable owner id selected at the start of the request.
    const currentHandleAudience = await readPublicProfileAudienceByHandle(supabase, decodedHandle)
    if (
      currentHandleAudience.status !== 'active' ||
      currentHandleAudience.profile.id !== audience.profile.id
    ) {
      return success({ collections: [] }, 404, NO_STORE_HEADERS)
    }

    const currentCollectionById = new Map(
      currentCollections.map((collection) => [collection.id, collection])
    )
    const result = collectionPageCandidates.flatMap((candidate) => {
      const currentCollection = currentCollectionById.get(candidate.id)
      if (!currentCollection) return []
      return [
        {
          ...currentCollection,
          item_count: itemCountByCollection.get(currentCollection.id) || 0,
        },
      ]
    })

    return success(
      {
        collections: result,
        pagination: {
          limit,
          offset,
          has_more: (collections?.length || 0) > limit,
        },
        item_counts_complete: !itemCandidatesWereTruncated,
      },
      200,
      NO_STORE_HEADERS
    )
  } catch (error: unknown) {
    return noStore(handleError(error, 'user-collections GET'))
  }
}
