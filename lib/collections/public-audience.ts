import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUDIENCE_RPC_CONCURRENCY = 8
export const MAX_COLLECTION_AUDIENCE_ITEMS = 500

export type ServiceReadableCollectionItem = {
  id: string
  collection_id: string
  item_id: string
  item_type: string
  note?: string | null
  added_at?: string | null
}

function itemAudienceIdentity(item: ServiceReadableCollectionItem): string {
  return `${item.collection_id}\u0000${item.item_type}\u0000${item.item_id}`
}

async function canServiceActorReadActivity(
  supabase: SupabaseClient<Database>,
  activityId: string,
  actorId: string | null
): Promise<boolean> {
  try {
    const result = await supabase.rpc('can_service_actor_read_activity', {
      p_activity_id: activityId,
      p_actor_id: actorId,
    })
    return result.error === null && typeof result.data === 'boolean' && result.data
  } catch {
    return false
  }
}

/**
 * Filter polymorphic collection references after a service-role read.
 *
 * A collection being public does not make its referenced resource public.
 * Posts therefore pass through the canonical post audience RPC, while public
 * activities pass through a service-only database decision that checks the
 * activity owner and any post target at request time. Unknown and malformed
 * legacy item kinds fail closed.
 */
export async function filterServiceReadableCollectionItems<T extends ServiceReadableCollectionItem>(
  supabase: SupabaseClient<Database>,
  items: readonly T[],
  actorId?: string | null
): Promise<T[]> {
  if (items.length === 0) return []
  if (items.length > MAX_COLLECTION_AUDIENCE_ITEMS) {
    throw new Error(
      `Collection audience candidate limit exceeded (${MAX_COLLECTION_AUDIENCE_ITEMS})`
    )
  }

  const postIds = [
    ...new Set(
      items
        .filter((item) => item.item_type === 'post' && UUID_PATTERN.test(item.item_id))
        .map((item) => item.item_id)
    ),
  ]
  const readablePostRows = await filterServiceReadablePostRows(
    supabase,
    postIds.map((id) => ({ id })),
    actorId ?? null
  )
  const readablePostIds = new Set(readablePostRows.map((row) => row.id))

  const activityIds = [
    ...new Set(
      items
        .filter((item) => item.item_type === 'activity' && UUID_PATTERN.test(item.item_id))
        .map((item) => item.item_id)
    ),
  ]
  const readableActivityIds = new Set<string>()
  for (let index = 0; index < activityIds.length; index += AUDIENCE_RPC_CONCURRENCY) {
    const chunk = activityIds.slice(index, index + AUDIENCE_RPC_CONCURRENCY)
    const decisions = await Promise.all(
      chunk.map(async (activityId) => ({
        activityId,
        readable: await canServiceActorReadActivity(supabase, activityId, actorId ?? null),
      }))
    )
    for (const decision of decisions) {
      if (decision.readable) readableActivityIds.add(decision.activityId)
    }
  }

  return items.filter((item) => {
    if (item.item_type === 'post') return readablePostIds.has(item.item_id)
    if (item.item_type === 'activity') return readableActivityIds.has(item.item_id)
    return false
  })
}

/**
 * Rebind audience-approved candidates to current collection_items rows.
 *
 * The audience decision is valid only for the exact collection/type/resource
 * tuple that was checked. Returning current rows also prevents a removed item
 * or an old note value from surviving in the response after the audience RPCs
 * finish.
 */
export function rebindServiceReadableCollectionItems<
  TCurrent extends ServiceReadableCollectionItem,
>(
  audienceApprovedItems: readonly ServiceReadableCollectionItem[],
  currentItems: readonly TCurrent[]
): TCurrent[] {
  const currentById = new Map(currentItems.map((item) => [item.id, item]))

  return audienceApprovedItems.flatMap((approvedItem) => {
    const currentItem = currentById.get(approvedItem.id)
    if (!currentItem || itemAudienceIdentity(currentItem) !== itemAudienceIdentity(approvedItem)) {
      return []
    }
    return [currentItem]
  })
}
