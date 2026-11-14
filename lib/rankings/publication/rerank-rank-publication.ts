import type { PublicationRpcClient } from './rpc-client'
import type { PublicationWindow } from './source-publication-evidence'

export const LEADERBOARD_PUBLIC_RERANK_CONTRACT = 'leaderboard-public-rerank@1'
export const LEADERBOARD_PUBLIC_RERANK_RPC_TIMEOUT_MS = 30_000
export const LEADERBOARD_PUBLIC_RERANK_MAX_TIMEOUT_MS = 60_000
export const LEADERBOARD_PUBLIC_RERANK_MAX_ROWS = 250_000
export const LEADERBOARD_PUBLIC_RERANK_MAX_UPDATED_ROWS = 2_147_483_647

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RERANK_RESPONSE_KEYS = [
  'contract',
  'eligible_rank_count',
  'score_cohort_id',
  'season_id',
  'updated_rank_count',
] as const

export type RerankRankPublicationErrorCode =
  | 'invalid_input'
  | 'rpc_call_error'
  | 'rpc_error'
  | 'rpc_null'
  | 'rpc_shape_mismatch'
  | 'rpc_aborted'
  | 'rpc_timeout'
  | 'rpc_ambiguous'

export class RerankRankPublicationError extends Error {
  constructor(
    public readonly code: RerankRankPublicationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RerankRankPublicationError'
  }
}

export interface RerankRankPublicationInput {
  season: PublicationWindow
  scoreCohortId: string
}

export interface RerankRankPublicationOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface LeaderboardPublicRerankResult {
  contract: typeof LEADERBOARD_PUBLIC_RERANK_CONTRACT
  season_id: PublicationWindow
  score_cohort_id: string
  eligible_rank_count: number
  updated_rank_count: number
}

interface RerankRpcArgs {
  p_season_id: PublicationWindow
  p_score_cohort_id: string
}

interface RpcEnvelope {
  data?: unknown
  error?: unknown
}

interface AbortableRpcQuery extends PromiseLike<RpcEnvelope> {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcEnvelope>
}

type RerankRpcClient = PublicationRpcClient

class AmbiguousRpcAttemptError extends Error {
  constructor(
    public readonly reason: 'timeout' | 'transport',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'AmbiguousRpcAttemptError'
  }
}

function fail(
  code: RerankRankPublicationErrorCode,
  message: string,
  options?: ErrorOptions
): never {
  throw new RerankRankPublicationError(code, message, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText)
  const sortedExpected = [...expected].sort(compareText)
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'aborted') === 'boolean' &&
    typeof Reflect.get(value, 'addEventListener') === 'function' &&
    typeof Reflect.get(value, 'removeEventListener') === 'function'
  )
}

function canonicalizeInput(input: RerankRankPublicationInput): RerankRpcArgs {
  if (!input || typeof input !== 'object') {
    fail('invalid_input', 'rerank input must be an object')
  }
  if (!['7D', '30D', '90D'].includes(input.season)) {
    fail('invalid_input', 'season must be exactly 7D, 30D, or 90D')
  }
  if (typeof input.scoreCohortId !== 'string' || !UUID_PATTERN.test(input.scoreCohortId)) {
    fail('invalid_input', 'scoreCohortId must be a canonical lowercase UUID')
  }

  return {
    p_season_id: input.season,
    p_score_cohort_id: input.scoreCohortId,
  }
}

function requireOptions(options: RerankRankPublicationOptions): {
  timeoutMs: number
  signal: AbortSignal | undefined
} {
  const timeoutMs = options.timeoutMs ?? LEADERBOARD_PUBLIC_RERANK_RPC_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > LEADERBOARD_PUBLIC_RERANK_MAX_TIMEOUT_MS
  ) {
    fail(
      'invalid_input',
      `timeoutMs must be a positive safe integer no greater than ${LEADERBOARD_PUBLIC_RERANK_MAX_TIMEOUT_MS}`
    )
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    fail('invalid_input', 'signal must be an AbortSignal')
  }
  return { timeoutMs, signal: options.signal }
}

function describeRpcError(error: unknown): string {
  if (!isRecord(error)) return String(error)
  const message = typeof error.message === 'string' ? error.message : 'unknown RPC error'
  const code = typeof error.code === 'string' ? error.code : 'unknown'
  return `${message} (code=${code})`
}

function callRerankRpc(supabase: RerankRpcClient, args: RerankRpcArgs): AbortableRpcQuery {
  let rpc: unknown
  try {
    rpc = Reflect.get(supabase, 'rpc')
  } catch (error) {
    fail('rpc_call_error', 'could not read the Supabase RPC function', { cause: error })
  }
  if (typeof rpc !== 'function') {
    fail('rpc_call_error', 'Supabase client has no RPC function')
  }

  let query: unknown
  try {
    // This RPC is intentionally dormant until its migration is deployed. Use
    // reflection so an older generated Database type cannot hide the runtime
    // endpoint or tempt callers to hand-edit generated types.
    query = Reflect.apply(rpc, supabase, ['rerank_leaderboard_publication', args])
  } catch (error) {
    fail('rpc_call_error', 'rerank_leaderboard_publication call failed before dispatch', {
      cause: error,
    })
  }

  if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
    fail('rpc_call_error', 'rerank_leaderboard_publication returned no query')
  }

  let then: unknown
  let abortSignal: unknown
  try {
    then = Reflect.get(query, 'then')
    abortSignal = Reflect.get(query, 'abortSignal')
  } catch (error) {
    fail('rpc_call_error', 'rerank_leaderboard_publication returned an unreadable query', {
      cause: error,
    })
  }
  if (typeof then !== 'function' && typeof abortSignal !== 'function') {
    fail('rpc_call_error', 'rerank_leaderboard_publication returned a non-awaitable query')
  }

  return query as AbortableRpcQuery
}

async function runRpcAttempt(
  supabase: RerankRpcClient,
  args: RerankRpcArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<RpcEnvelope> {
  if (externalSignal?.aborted) {
    fail('rpc_aborted', 'leaderboard publication rerank was aborted before dispatch')
  }

  const query = callRerankRpc(supabase, args)
  const controller = new AbortController()
  let timedOut = false
  let externallyAborted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeExternalAbortListener: (() => void) | undefined

  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('leaderboard publication rerank deadline exceeded'))
    }, timeoutMs)

    if (externalSignal) {
      const onAbort = () => {
        externallyAborted = true
        controller.abort(externalSignal.reason)
        reject(new Error('leaderboard publication rerank aborted by caller'))
      }
      externalSignal.addEventListener('abort', onAbort, { once: true })
      removeExternalAbortListener = () => externalSignal.removeEventListener('abort', onAbort)
      if (externalSignal.aborted) onAbort()
    }
  })

  try {
    let awaitable: PromiseLike<RpcEnvelope>
    try {
      const bindAbortSignal = Reflect.get(query, 'abortSignal')
      awaitable =
        typeof bindAbortSignal === 'function'
          ? (Reflect.apply(bindAbortSignal, query, [controller.signal]) as PromiseLike<RpcEnvelope>)
          : query
    } catch (error) {
      fail('rpc_call_error', 'rerank RPC could not attach its AbortSignal before dispatch', {
        cause: error,
      })
    }
    if (!awaitable || typeof Reflect.get(awaitable, 'then') !== 'function') {
      fail('rpc_call_error', 'rerank RPC AbortSignal binding returned a non-awaitable query')
    }

    return await Promise.race([Promise.resolve(awaitable), interruption])
  } catch (error) {
    if (error instanceof RerankRankPublicationError) throw error
    if (externallyAborted) {
      fail('rpc_aborted', 'leaderboard publication rerank was aborted by caller', { cause: error })
    }
    if (timedOut) {
      throw new AmbiguousRpcAttemptError(
        'timeout',
        `rerank_leaderboard_publication exceeded its ${timeoutMs}ms deadline`,
        { cause: error }
      )
    }
    throw new AmbiguousRpcAttemptError(
      'transport',
      'rerank_leaderboard_publication lost its response after dispatch',
      { cause: error }
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeExternalAbortListener?.()
  }
}

function requireResponseCount(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(
      'rpc_shape_mismatch',
      `${label} must be a non-negative safe integer no greater than ${maximum}`
    )
  }
  return value as number
}

function parseRerankResponse(
  data: unknown,
  expectedSeason: PublicationWindow,
  expectedScoreCohortId: string
): LeaderboardPublicRerankResult {
  if (!isRecord(data) || !hasExactKeys(data, RERANK_RESPONSE_KEYS)) {
    fail('rpc_shape_mismatch', 'rerank RPC returned an invalid response shape')
  }
  if (
    data.contract !== LEADERBOARD_PUBLIC_RERANK_CONTRACT ||
    data.season_id !== expectedSeason ||
    data.score_cohort_id !== expectedScoreCohortId
  ) {
    fail('rpc_shape_mismatch', 'rerank RPC response does not match the requested cohort')
  }

  const eligibleRankCount = requireResponseCount(
    data.eligible_rank_count,
    'eligible_rank_count',
    LEADERBOARD_PUBLIC_RERANK_MAX_ROWS
  )
  const updatedRankCount = requireResponseCount(
    data.updated_rank_count,
    'updated_rank_count',
    LEADERBOARD_PUBLIC_RERANK_MAX_UPDATED_ROWS
  )

  // updated_rank_count may exceed eligible_rank_count: the terminal statement
  // also clears ranks from non-authority/ineligible season rows. The protocol
  // eligible rows have the RPC's explicit 250k ceiling. Updated rows can also
  // include every stale/ineligible season row whose old rank is cleared, so
  // their ceiling is PostgreSQL integer rather than the eligible-population cap.
  return {
    contract: LEADERBOARD_PUBLIC_RERANK_CONTRACT,
    season_id: expectedSeason,
    score_cohort_id: expectedScoreCohortId,
    eligible_rank_count: eligibleRankCount,
    updated_rank_count: updatedRankCount,
  }
}

/**
 * Assign the terminal, globally deterministic ranks for one already-written
 * publication cohort. The RPC is idempotent for a fixed season/cohort pair, so
 * a lost response is retried once with the exact same argument object. A
 * deterministic database response is never retried.
 */
export async function rerankLeaderboardPublication(
  supabase: RerankRpcClient,
  input: RerankRankPublicationInput,
  options: RerankRankPublicationOptions = {}
): Promise<LeaderboardPublicRerankResult> {
  const args = canonicalizeInput(input)
  const { timeoutMs, signal } = requireOptions(options)
  let lastAmbiguousError: AmbiguousRpcAttemptError | undefined

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: RpcEnvelope
    try {
      response = await runRpcAttempt(supabase, args, timeoutMs, signal)
    } catch (error) {
      if (!(error instanceof AmbiguousRpcAttemptError)) throw error
      lastAmbiguousError = error
      if (attempt === 1 && !signal?.aborted) continue

      fail(
        error.reason === 'timeout' ? 'rpc_timeout' : 'rpc_ambiguous',
        `rerank RPC remained ambiguous after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
        { cause: error }
      )
    }

    if (!isRecord(response)) {
      fail('rpc_error', 'rerank RPC returned no envelope')
    }
    if (response.error !== null && response.error !== undefined) {
      fail('rpc_error', `rerank RPC failed: ${describeRpcError(response.error)}`)
    }
    if (response.data === null || response.data === undefined) {
      fail('rpc_null', 'rerank RPC returned null data')
    }

    return parseRerankResponse(response.data, args.p_season_id, args.p_score_cohort_id)
  }

  fail('rpc_ambiguous', 'rerank RPC did not produce a definitive response', {
    cause: lastAmbiguousError,
  })
}
