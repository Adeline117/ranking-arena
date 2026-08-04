/**
 * In-process cron mutations shared by scheduled dispatchers.
 *
 * Trader discovery and refresh_jobs processing were retired: the BullMQ ingest
 * worker is the sole first-party ranking ingestion authority.
 */

import { del as cacheDelete } from '@/lib/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export interface InlineJobResult {
  name: string
  status: 'success' | 'error'
  durationMs: number
  detail?: Record<string, unknown>
  error?: string
}

const HOT_POSTS_CACHE_KEY = 'hot_posts:top50'
const COMMENT_REACTION_REPAIR_RPC_LIMIT = 1
const COMMENT_REACTION_REPAIR_MAX_CALLS = 100
const COMMENT_REACTION_REPAIR_TIME_BUDGET_MS = 75_000
const COMMENT_REACTION_REPAIR_MAX_BACKLOG = 1_000
const COMMENT_REACTION_REPAIR_MAX_AGE_MS = 15 * 60_000
const COMMENT_REACTION_REPAIR_ACK_KEYS = [
  'contended_count',
  'discarded_count',
  'has_more',
  'oldest_enqueued_at',
  'processed_count',
  'remaining_count',
  'repaired_count',
  'selected_count',
  'status',
] as const
const POST_INTERACTION_REPAIR_RPC_LIMIT = 1
const POST_INTERACTION_REPAIR_MAX_CALLS = 100
const POST_INTERACTION_REPAIR_TIME_BUDGET_MS = 75_000
const POST_INTERACTION_REPAIR_MAX_BACKLOG = 1_000
const POST_INTERACTION_REPAIR_MAX_AGE_MS = 15 * 60_000
const POST_INTERACTION_REPAIR_ACK_KEYS = [
  'contended_count',
  'discarded_count',
  'has_more',
  'oldest_enqueued_at',
  'processed_count',
  'remaining_count',
  'repaired_count',
  'selected_count',
  'status',
] as const
const ISO_TIMESTAMP_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

type HotScoreRpcName =
  | 'update_post_velocity'
  | 'update_post_report_counts'
  | 'refresh_hot_scores_incremental'
  | 'refresh_hot_scores'

function isExactMutationCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

interface PostInteractionRepairAcknowledgement {
  status: 'processed'
  selected_count: number
  processed_count: number
  repaired_count: number
  discarded_count: number
  contended_count: number
  has_more: boolean
  remaining_count: number
  oldest_enqueued_at: string | null
}

interface CommentReactionRepairAcknowledgement {
  status: 'processed'
  selected_count: number
  processed_count: number
  repaired_count: number
  discarded_count: number
  contended_count: number
  has_more: boolean
  remaining_count: number
  oldest_enqueued_at: string | null
}

type CommentReactionRepairStopReason = 'no-due-work' | 'contention' | 'call-limit' | 'time-budget'

type PostInteractionRepairStopReason = 'no-due-work' | 'contention' | 'call-limit' | 'time-budget'

function hasExactCommentReactionRepairAcknowledgementKeys(
  value: Record<string, unknown>
): value is Record<(typeof COMMENT_REACTION_REPAIR_ACK_KEYS)[number], unknown> {
  const keys = Object.keys(value).sort()
  return (
    keys.length === COMMENT_REACTION_REPAIR_ACK_KEYS.length &&
    COMMENT_REACTION_REPAIR_ACK_KEYS.every((key, index) => keys[index] === key)
  )
}

function hasExactRepairAcknowledgementKeys(
  value: Record<string, unknown>
): value is Record<(typeof POST_INTERACTION_REPAIR_ACK_KEYS)[number], unknown> {
  const keys = Object.keys(value).sort()
  return (
    keys.length === POST_INTERACTION_REPAIR_ACK_KEYS.length &&
    POST_INTERACTION_REPAIR_ACK_KEYS.every((key, index) => keys[index] === key)
  )
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_TIMESTAMP_WITH_TIMEZONE.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function parseCommentReactionRepairAcknowledgement(
  value: unknown
): CommentReactionRepairAcknowledgement {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !hasExactCommentReactionRepairAcknowledgementKeys(value as Record<string, unknown>)
  ) {
    throw new Error('repair_comment_reaction_counts_atomic returned an invalid acknowledgement')
  }

  const acknowledgement = value as Record<
    (typeof COMMENT_REACTION_REPAIR_ACK_KEYS)[number],
    unknown
  >
  if (
    acknowledgement.status !== 'processed' ||
    typeof acknowledgement.has_more !== 'boolean' ||
    !isExactMutationCount(acknowledgement.selected_count) ||
    !isExactMutationCount(acknowledgement.processed_count) ||
    !isExactMutationCount(acknowledgement.repaired_count) ||
    !isExactMutationCount(acknowledgement.discarded_count) ||
    !isExactMutationCount(acknowledgement.contended_count) ||
    !isExactMutationCount(acknowledgement.remaining_count) ||
    (acknowledgement.oldest_enqueued_at !== null &&
      !isIsoTimestamp(acknowledgement.oldest_enqueued_at))
  ) {
    throw new Error('repair_comment_reaction_counts_atomic returned an invalid acknowledgement')
  }

  const parsed: CommentReactionRepairAcknowledgement = {
    status: acknowledgement.status,
    selected_count: acknowledgement.selected_count,
    processed_count: acknowledgement.processed_count,
    repaired_count: acknowledgement.repaired_count,
    discarded_count: acknowledgement.discarded_count,
    contended_count: acknowledgement.contended_count,
    has_more: acknowledgement.has_more,
    remaining_count: acknowledgement.remaining_count,
    oldest_enqueued_at: acknowledgement.oldest_enqueued_at,
  }
  const selectedCount = parsed.selected_count
  const processedCount = parsed.processed_count
  const repairedCount = parsed.repaired_count
  const discardedCount = parsed.discarded_count
  const contendedCount = parsed.contended_count
  const remainingCount = parsed.remaining_count

  if (
    selectedCount > COMMENT_REACTION_REPAIR_RPC_LIMIT ||
    processedCount > COMMENT_REACTION_REPAIR_RPC_LIMIT ||
    repairedCount + discardedCount !== processedCount ||
    processedCount + contendedCount !== selectedCount ||
    (remainingCount === 0 && (parsed.has_more || parsed.oldest_enqueued_at !== null)) ||
    (remainingCount > 0 && parsed.oldest_enqueued_at === null) ||
    (parsed.has_more && remainingCount === 0)
  ) {
    throw new Error('repair_comment_reaction_counts_atomic returned an invalid acknowledgement')
  }

  return parsed
}

function parsePostInteractionRepairAcknowledgement(
  value: unknown
): PostInteractionRepairAcknowledgement {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !hasExactRepairAcknowledgementKeys(value as Record<string, unknown>)
  ) {
    throw new Error('repair_post_interaction_counts_atomic returned an invalid acknowledgement')
  }

  const acknowledgement = value as Record<
    (typeof POST_INTERACTION_REPAIR_ACK_KEYS)[number],
    unknown
  >
  const countKeys = [
    'selected_count',
    'processed_count',
    'repaired_count',
    'discarded_count',
    'contended_count',
    'remaining_count',
  ] as const

  if (
    acknowledgement.status !== 'processed' ||
    typeof acknowledgement.has_more !== 'boolean' ||
    !countKeys.every((key) => isExactMutationCount(acknowledgement[key])) ||
    (acknowledgement.oldest_enqueued_at !== null &&
      !isIsoTimestamp(acknowledgement.oldest_enqueued_at))
  ) {
    throw new Error('repair_post_interaction_counts_atomic returned an invalid acknowledgement')
  }

  const parsed = acknowledgement as unknown as PostInteractionRepairAcknowledgement
  const selectedCount = parsed.selected_count
  const processedCount = parsed.processed_count
  const repairedCount = parsed.repaired_count
  const discardedCount = parsed.discarded_count
  const contendedCount = parsed.contended_count
  const remainingCount = parsed.remaining_count

  if (
    selectedCount > POST_INTERACTION_REPAIR_RPC_LIMIT ||
    processedCount > POST_INTERACTION_REPAIR_RPC_LIMIT ||
    repairedCount + discardedCount !== processedCount ||
    processedCount + contendedCount !== selectedCount ||
    (remainingCount === 0 && (parsed.has_more || parsed.oldest_enqueued_at !== null)) ||
    (remainingCount > 0 && parsed.oldest_enqueued_at === null) ||
    (parsed.has_more && remainingCount === 0)
  ) {
    throw new Error('repair_post_interaction_counts_atomic returned an invalid acknowledgement')
  }

  return parsed
}

function throwIfRepairAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error('post interaction count repair aborted')
}

async function executePostInteractionRepairRpc(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  signal?: AbortSignal
) {
  const request = supabase.rpc('repair_post_interaction_counts_atomic', {
    p_limit: POST_INTERACTION_REPAIR_RPC_LIMIT,
  })
  return signal ? await request.abortSignal(signal) : await request
}

function repairBacklogError(
  acknowledgement: PostInteractionRepairAcknowledgement,
  observedAt: number
): { message: string; oldestAgeMs: number | null } | null {
  const oldestAgeMs =
    acknowledgement.oldest_enqueued_at === null
      ? null
      : Math.max(0, observedAt - Date.parse(acknowledgement.oldest_enqueued_at))
  const failures: string[] = []

  if (acknowledgement.remaining_count > POST_INTERACTION_REPAIR_MAX_BACKLOG) {
    failures.push(
      `remaining_count ${acknowledgement.remaining_count} exceeds ${POST_INTERACTION_REPAIR_MAX_BACKLOG}`
    )
  }
  if (oldestAgeMs !== null && oldestAgeMs > POST_INTERACTION_REPAIR_MAX_AGE_MS) {
    failures.push(
      `oldest item age ${oldestAgeMs}ms exceeds ${POST_INTERACTION_REPAIR_MAX_AGE_MS}ms`
    )
  }

  return failures.length > 0
    ? {
        message: `post interaction repair backlog unhealthy: ${failures.join('; ')}`,
        oldestAgeMs,
      }
    : null
}

function throwIfCommentReactionRepairAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error('comment reaction count repair aborted')
}

async function executeCommentReactionRepairRpc(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  signal?: AbortSignal
) {
  const request = supabase.rpc('repair_comment_reaction_counts_atomic', {
    p_limit: COMMENT_REACTION_REPAIR_RPC_LIMIT,
  })
  return signal ? await request.abortSignal(signal) : await request
}

function commentReactionRepairBacklogError(
  acknowledgement: CommentReactionRepairAcknowledgement,
  observedAt: number
): { message: string; oldestAgeMs: number | null } | null {
  const oldestAgeMs =
    acknowledgement.oldest_enqueued_at === null
      ? null
      : Math.max(0, observedAt - Date.parse(acknowledgement.oldest_enqueued_at))
  const failures: string[] = []

  if (acknowledgement.remaining_count > COMMENT_REACTION_REPAIR_MAX_BACKLOG) {
    failures.push(
      `remaining_count ${acknowledgement.remaining_count} exceeds ${COMMENT_REACTION_REPAIR_MAX_BACKLOG}`
    )
  }
  if (oldestAgeMs !== null && oldestAgeMs > COMMENT_REACTION_REPAIR_MAX_AGE_MS) {
    failures.push(
      `oldest item age ${oldestAgeMs}ms exceeds ${COMMENT_REACTION_REPAIR_MAX_AGE_MS}ms`
    )
  }

  return failures.length > 0
    ? {
        message: `comment reaction repair backlog unhealthy: ${failures.join('; ')}`,
        oldestAgeMs,
      }
    : null
}

/**
 * Drain durable comment reaction counter repairs in separate transactions.
 *
 * Keeping p_limit at one ensures that every awaited RPC commits and releases
 * its comment-row lock before the next repair obligation is attempted.
 */
export async function repairCommentReactionCountsInline(
  signal?: AbortSignal
): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'repair-comment-reaction-counts'

  try {
    const supabase = getSupabaseAdmin()
    let rpcCalls = 0
    let selectedCount = 0
    let processedCount = 0
    let repairedCount = 0
    let discardedCount = 0
    let contendedCount = 0
    let lastAcknowledgement: CommentReactionRepairAcknowledgement | null = null
    let stopReason: CommentReactionRepairStopReason = 'call-limit'

    while (rpcCalls < COMMENT_REACTION_REPAIR_MAX_CALLS) {
      throwIfCommentReactionRepairAborted(signal)
      if (rpcCalls > 0 && Date.now() - start >= COMMENT_REACTION_REPAIR_TIME_BUDGET_MS) {
        stopReason = 'time-budget'
        break
      }

      const { data, error } = await executeCommentReactionRepairRpc(supabase, signal)
      rpcCalls += 1
      throwIfCommentReactionRepairAborted(signal)
      if (error) {
        throw new Error(
          `repair_comment_reaction_counts_atomic failed: ${error.message || 'database error'}`
        )
      }

      const acknowledgement = parseCommentReactionRepairAcknowledgement(data)
      lastAcknowledgement = acknowledgement
      selectedCount += acknowledgement.selected_count
      processedCount += acknowledgement.processed_count
      repairedCount += acknowledgement.repaired_count
      discardedCount += acknowledgement.discarded_count
      contendedCount += acknowledgement.contended_count

      if (acknowledgement.contended_count > 0 && acknowledgement.processed_count === 0) {
        stopReason = 'contention'
        break
      }
      if (acknowledgement.selected_count === 0 || !acknowledgement.has_more) {
        stopReason = 'no-due-work'
        break
      }
      if (Date.now() - start >= COMMENT_REACTION_REPAIR_TIME_BUDGET_MS) {
        stopReason = 'time-budget'
        break
      }
    }

    if (lastAcknowledgement === null) {
      throw new Error('comment reaction count repair stopped without an acknowledgement')
    }

    const observedAt = Date.now()
    const backlogFailure = commentReactionRepairBacklogError(lastAcknowledgement, observedAt)
    const detail = {
      rpcCalls,
      selectedCount,
      processedCount,
      repairedCount,
      discardedCount,
      contendedCount,
      hasMore: lastAcknowledgement.has_more,
      remainingCount: lastAcknowledgement.remaining_count,
      oldestEnqueuedAt: lastAcknowledgement.oldest_enqueued_at,
      oldestAgeMs:
        lastAcknowledgement.oldest_enqueued_at === null
          ? null
          : Math.max(0, observedAt - Date.parse(lastAcknowledgement.oldest_enqueued_at)),
      stopReason,
    }

    if (backlogFailure) {
      return {
        name,
        status: 'error',
        durationMs: observedAt - start,
        detail: { ...detail, backlogExceeded: true },
        error: backlogFailure.message,
      }
    }

    return {
      name,
      status: 'success',
      durationMs: observedAt - start,
      detail,
    }
  } catch (err) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Drain durable post interaction counter repairs in separate transactions.
 *
 * The database authority takes P/posts/Q locks. Keeping p_limit at one means
 * every awaited Supabase RPC commits and releases that lock set before the next
 * queue item is attempted.
 */
export async function repairPostInteractionCountsInline(
  signal?: AbortSignal
): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'repair-post-interaction-counts'

  try {
    const supabase = getSupabaseAdmin()
    let rpcCalls = 0
    let selectedCount = 0
    let processedCount = 0
    let repairedCount = 0
    let discardedCount = 0
    let contendedCount = 0
    let lastAcknowledgement: PostInteractionRepairAcknowledgement | null = null
    let stopReason: PostInteractionRepairStopReason = 'call-limit'

    while (rpcCalls < POST_INTERACTION_REPAIR_MAX_CALLS) {
      throwIfRepairAborted(signal)
      if (rpcCalls > 0 && Date.now() - start >= POST_INTERACTION_REPAIR_TIME_BUDGET_MS) {
        stopReason = 'time-budget'
        break
      }

      const { data, error } = await executePostInteractionRepairRpc(supabase, signal)
      rpcCalls += 1
      throwIfRepairAborted(signal)
      if (error) {
        throw new Error(
          `repair_post_interaction_counts_atomic failed: ${error.message || 'database error'}`
        )
      }

      const acknowledgement = parsePostInteractionRepairAcknowledgement(data)
      lastAcknowledgement = acknowledgement
      selectedCount += acknowledgement.selected_count
      processedCount += acknowledgement.processed_count
      repairedCount += acknowledgement.repaired_count
      discardedCount += acknowledgement.discarded_count
      contendedCount += acknowledgement.contended_count

      if (acknowledgement.contended_count > 0 && acknowledgement.processed_count === 0) {
        stopReason = 'contention'
        break
      }
      if (acknowledgement.selected_count === 0 || !acknowledgement.has_more) {
        stopReason = 'no-due-work'
        break
      }
      if (Date.now() - start >= POST_INTERACTION_REPAIR_TIME_BUDGET_MS) {
        stopReason = 'time-budget'
        break
      }
    }

    if (lastAcknowledgement === null) {
      throw new Error('post interaction count repair stopped without an acknowledgement')
    }

    const observedAt = Date.now()
    const backlogFailure = repairBacklogError(lastAcknowledgement, observedAt)
    const detail = {
      rpcCalls,
      selectedCount,
      processedCount,
      repairedCount,
      discardedCount,
      contendedCount,
      hasMore: lastAcknowledgement.has_more,
      remainingCount: lastAcknowledgement.remaining_count,
      oldestEnqueuedAt: lastAcknowledgement.oldest_enqueued_at,
      oldestAgeMs:
        lastAcknowledgement.oldest_enqueued_at === null
          ? null
          : Math.max(0, observedAt - Date.parse(lastAcknowledgement.oldest_enqueued_at)),
      stopReason,
    }

    if (backlogFailure) {
      return {
        name,
        status: 'error',
        durationMs: observedAt - start,
        detail: { ...detail, backlogExceeded: true },
        error: backlogFailure.message,
      }
    }

    return {
      name,
      status: 'success',
      durationMs: observedAt - start,
      detail,
    }
  } catch (err) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function requireMutationCount(
  rpcName: string,
  data: unknown,
  error: { message?: string } | null
): number {
  if (error) throw new Error(`${rpcName} failed: ${error.message || 'database error'}`)
  if (!isExactMutationCount(data)) {
    throw new Error(`${rpcName} returned an invalid mutation count`)
  }
  return data
}

async function executeHotScoreRpc(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rpcName: HotScoreRpcName,
  signal?: AbortSignal
) {
  const request = supabase.rpc(rpcName)
  return signal ? await request.abortSignal(signal) : await request
}

export async function refreshHotScoresInline(signal?: AbortSignal): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'refresh-hot-scores'
  try {
    const supabase = getSupabaseAdmin()

    // Velocity and report counts are inputs to the canonical score function.
    // Continuing after either write fails publishes rankings from stale inputs.
    const { data: velocityData, error: velocityError } = await executeHotScoreRpc(
      supabase,
      'update_post_velocity',
      signal
    )
    const velocityCount = requireMutationCount('update_post_velocity', velocityData, velocityError)

    const { data: reportData, error: reportError } = await executeHotScoreRpc(
      supabase,
      'update_post_report_counts',
      signal
    )
    const reportCount = requireMutationCount('update_post_report_counts', reportData, reportError)

    const { data: incCount, error: incErr } = await executeHotScoreRpc(
      supabase,
      'refresh_hot_scores_incremental',
      signal
    )
    if (!incErr && isExactMutationCount(incCount)) {
      await cacheDelete(HOT_POSTS_CACHE_KEY)
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: {
          method: 'incremental',
          count: incCount,
          velocityCount,
          reportCount,
        },
      }
    }

    const { data: fullCount, error: fullErr } = await executeHotScoreRpc(
      supabase,
      'refresh_hot_scores',
      signal
    )
    if (!fullErr && isExactMutationCount(fullCount)) {
      await cacheDelete(HOT_POSTS_CACHE_KEY)
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: { method: 'full', count: fullCount, velocityCount, reportCount },
      }
    }

    const incrementalFailure = incErr?.message || 'invalid mutation count'
    const fullFailure = fullErr?.message || 'invalid mutation count'
    throw new Error(
      `Hot score refresh authorities failed (incremental: ${incrementalFailure}; full: ${fullFailure})`
    )
  } catch (err) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
