import type { SupabaseClient } from '@supabase/supabase-js'

// This module is imported by an Edge route. Keep its runtime dependency graph
// limited to supabase-js + platform globals; the shared logger dynamically
// probes Node correlation/Sentry facilities and needlessly widens that bundle.
function logAudienceFailure(level: 'warn' | 'error', message: string, detail?: unknown): void {
  if (process.env.NODE_ENV === 'test') return
  // eslint-disable-next-line no-console -- console is available in both Edge and Node runtimes
  console[level](message, detail ?? '')
}

export type ServiceReadablePostCandidate = {
  id: string
  group_id?: string | null
  visibility?: string | null
  status?: string | null
  deleted_at?: string | null
}

// Keep serverless connection pressure bounded. The deployed authorization
// primitive accepts one post at a time, so a small worker window gives us a
// rollout-safe batch without depending on a newer database migration.
const AUDIENCE_RPC_CONCURRENCY = 8

type AudienceDecision = {
  id: string
  readable: boolean
  failureCode?: string
}

async function readAudienceDecision(
  supabase: SupabaseClient,
  postId: string,
  actorId: string | null
): Promise<AudienceDecision> {
  try {
    const result = (await supabase.rpc('can_service_actor_read_post', {
      p_post_id: postId,
      p_actor_id: actorId,
    })) as { data: unknown; error: { code?: string } | null } | null | undefined

    if (!result || typeof result !== 'object') {
      return { id: postId, readable: false, failureCode: 'missing-acknowledgement' }
    }
    if (result.error) {
      return { id: postId, readable: false, failureCode: result.error.code || 'database-error' }
    }
    if (typeof result.data !== 'boolean') {
      return { id: postId, readable: false, failureCode: 'malformed-acknowledgement' }
    }
    return { id: postId, readable: result.data }
  } catch (error) {
    return {
      id: postId,
      readable: false,
      failureCode: error instanceof Error ? error.name : 'thrown-error',
    }
  }
}

/**
 * Apply the canonical audience decision to rows fetched with the service role.
 *
 * The service client bypasses posts RLS, so callers must never return its raw
 * rows. Local row fields cannot prove root-post visibility, account health, or
 * the absence of a viewer/author block edge. Any RPC failure therefore denies
 * that candidate. Only an explicit boolean true from the deployed canonical
 * function may release a service-role row.
 */
export async function filterServiceReadablePostRows<T extends ServiceReadablePostCandidate>(
  supabase: SupabaseClient,
  rows: readonly T[],
  actorId?: string | null
): Promise<T[]> {
  if (rows.length === 0) return []

  const postIds = [...new Set(rows.map((row) => row.id).filter(Boolean))]
  if (postIds.length === 0) return []

  const decisions: AudienceDecision[] = []
  for (let index = 0; index < postIds.length; index += AUDIENCE_RPC_CONCURRENCY) {
    const chunk = postIds.slice(index, index + AUDIENCE_RPC_CONCURRENCY)
    decisions.push(
      ...(await Promise.all(
        chunk.map((postId) => readAudienceDecision(supabase, postId, actorId ?? null))
      ))
    )
  }

  const failures = decisions.filter((decision) => decision.failureCode)
  if (failures.length > 0) {
    logAudienceFailure('warn', '[posts] canonical service audience checks failed closed', {
      failed: failures.length,
      total: postIds.length,
      firstCode: failures[0].failureCode,
    })
  }

  const readableIds = new Set(
    decisions.filter((decision) => decision.readable).map((decision) => decision.id)
  )
  return rows.filter((row) => readableIds.has(row.id))
}

/** Check a post audience without returning any post payload to the caller. */
export async function canServiceActorReadPost(
  supabase: SupabaseClient,
  postId: string,
  actorId?: string | null
): Promise<boolean> {
  const readable = await filterServiceReadablePostRows(supabase, [{ id: postId }], actorId)
  return readable.length === 1
}
