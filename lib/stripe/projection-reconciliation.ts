import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type ProProjectionReconciliation = {
  processedCount: number
  authorityCount: number
  pages: number
}

function parsePage(value: unknown, limit: number, previousCursor: string | null) {
  const page =
    value && !Array.isArray(value) && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  const processedCount = page?.processed_count
  const authorityCount = page?.authority_count
  const nextCursor = page?.next_cursor
  const hasMore = page?.has_more
  if (
    page?.status !== 'reconciled' ||
    !Number.isSafeInteger(processedCount) ||
    (processedCount as number) < 0 ||
    (processedCount as number) > limit ||
    !Number.isSafeInteger(authorityCount) ||
    (authorityCount as number) < 0 ||
    (authorityCount as number) > (processedCount as number) ||
    typeof hasMore !== 'boolean' ||
    (nextCursor !== null &&
      (typeof nextCursor !== 'string' ||
        nextCursor !== nextCursor.toLowerCase() ||
        !UUID_PATTERN.test(nextCursor))) ||
    (hasMore &&
      (processedCount !== limit ||
        typeof nextCursor !== 'string' ||
        nextCursor === previousCursor)) ||
    (!hasMore && processedCount === 0 && nextCursor !== null)
  ) {
    throw new Error('Pro projection reconciliation returned an invalid page')
  }
  return {
    processedCount: processedCount as number,
    authorityCount: authorityCount as number,
    nextCursor: nextCursor as string | null,
    hasMore,
  }
}

export async function reconcileAllDueProEntitlementProjections(
  supabase: SupabaseClient<Database>,
  options: { pageLimit?: number; maxPages?: number } = {}
): Promise<ProProjectionReconciliation> {
  const pageLimit = options.pageLimit ?? 500
  const maxPages = options.maxPages ?? 100
  if (
    !Number.isSafeInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > 500 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1_000
  ) {
    throw new Error('Pro projection reconciliation bounds are invalid')
  }

  let cursor: string | null = null
  let processedCount = 0
  let authorityCount = 0

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const { data, error } = await supabase.rpc('reconcile_due_pro_entitlement_projections_atomic', {
      p_limit: pageLimit,
      p_after_user_id: cursor,
    })
    if (error) {
      throw new Error(`Failed to reconcile Pro entitlement projections: ${error.message}`)
    }

    const page = parsePage(data, pageLimit, cursor)
    processedCount += page.processedCount
    authorityCount += page.authorityCount
    if (!page.hasMore) {
      return { processedCount, authorityCount, pages: pageNumber }
    }
    cursor = page.nextCursor
  }

  throw new Error('Pro projection reconciliation exceeded its page budget')
}
