import type { getSupabaseAdmin } from '@/lib/api'
import type { Period } from '@/lib/utils/arena-score'
import { mapArenaScoreRowToTraderRow } from './arena-score-row-mapper'
import {
  DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS,
  parseSourcePublicationEvidence,
  type ParsedSourcePublicationEvidence,
  type SourcePublicationScoreRow,
} from './source-publication-evidence'
import type { TraderRow } from './trader-row'

export const SOURCE_PUBLICATION_PER_ALIAS_LIMIT = 1000
export const SOURCE_PUBLICATION_RPC_TIMEOUT_MS = 30_000

export type SourcePublicationBundleReaderErrorCode =
  | 'invalid_option'
  | 'rpc_error'
  | 'rpc_null'
  | 'rpc_timeout'

export class SourcePublicationBundleReaderError extends Error {
  constructor(
    public readonly code: SourcePublicationBundleReaderErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SourcePublicationBundleReaderError'
  }
}

export interface ReadSourcePublicationBundleOptions {
  perAliasLimit?: number
  maxAgeHours?: number
  timeoutMs?: number
  now?: Date
}

export interface ReadSourcePublicationBundleDependencies {
  mapScoreRow?: (row: SourcePublicationScoreRow) => TraderRow
}

export interface ReadSourcePublicationBundleResult {
  evidence: ParsedSourcePublicationEvidence
  traderRows: TraderRow[]
  freshRowCounts: Map<string, number>
}

interface RpcEnvelope {
  data?: unknown
  error?: unknown
}

interface AbortableRpcQuery extends PromiseLike<RpcEnvelope> {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcEnvelope>
}

type SourcePublicationRpcClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'rpc'>

function fail(code: SourcePublicationBundleReaderErrorCode, message: string): never {
  throw new SourcePublicationBundleReaderError(code, message)
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid_option', `${label} must be a positive safe integer`)
  }
  return value
}

function describeRpcError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const record = error as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : 'unknown RPC error'
  const code = typeof record.code === 'string' ? record.code : 'unknown'
  return `${message} (code=${code})`
}

function callPublicationBundleRpc(
  supabase: SourcePublicationRpcClient,
  window: Period,
  perAliasLimit: number,
  maxAgeHours: number
): AbortableRpcQuery {
  const rpc = Reflect.get(supabase, 'rpc')
  if (typeof rpc !== 'function') {
    fail('rpc_error', `[${window}] Supabase client has no RPC function`)
  }

  const query: unknown = Reflect.apply(rpc, supabase, [
    'arena_score_inputs_publish_bundle_json',
    {
      p_window: window,
      p_per_platform_limit: perAliasLimit,
      p_max_age_hours: maxAgeHours,
    },
  ])
  if (!query || typeof query !== 'object') {
    fail('rpc_error', `[${window}] publication RPC returned no query`)
  }

  const then = Reflect.get(query, 'then')
  const abortSignal = Reflect.get(query, 'abortSignal')
  if (typeof then !== 'function' && typeof abortSignal !== 'function') {
    fail('rpc_error', `[${window}] publication RPC returned a non-awaitable query`)
  }
  return query as AbortableRpcQuery
}

async function runRpcWithTimeout(
  query: AbortableRpcQuery,
  timeoutMs: number,
  window: Period
): Promise<RpcEnvelope> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('source publication RPC deadline exceeded'))
    }, timeoutMs)
  })

  try {
    const abortableQuery =
      typeof query.abortSignal === 'function' ? query.abortSignal(controller.signal) : query
    return await Promise.race([Promise.resolve(abortableQuery), timeout])
  } catch (error) {
    if (timedOut) {
      return fail(
        'rpc_timeout',
        `[${window}] arena_score_inputs_publish_bundle_json timed out after ${timeoutMs}ms`
      )
    }
    return fail(
      'rpc_error',
      `[${window}] arena_score_inputs_publish_bundle_json transport failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Read and fully validate one immutable publication bundle before projecting
 * any row into compute's temporary TraderRow representation. This module is
 * intentionally not imported by the active route until the RPC migration has
 * been deployed and the cutover receives a separate review.
 */
export async function readSourcePublicationBundle(
  supabase: SourcePublicationRpcClient,
  window: Period,
  options: ReadSourcePublicationBundleOptions = {},
  dependencies: ReadSourcePublicationBundleDependencies = {}
): Promise<ReadSourcePublicationBundleResult> {
  const perAliasLimit = requirePositiveSafeInteger(
    options.perAliasLimit ?? SOURCE_PUBLICATION_PER_ALIAS_LIMIT,
    'perAliasLimit'
  )
  const maxAgeHours = requirePositiveSafeInteger(
    options.maxAgeHours ?? DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS,
    'maxAgeHours'
  )
  const timeoutMs = requirePositiveSafeInteger(
    options.timeoutMs ?? SOURCE_PUBLICATION_RPC_TIMEOUT_MS,
    'timeoutMs'
  )

  let query: AbortableRpcQuery
  try {
    query = callPublicationBundleRpc(supabase, window, perAliasLimit, maxAgeHours)
  } catch (error) {
    if (error instanceof SourcePublicationBundleReaderError) throw error
    fail(
      'rpc_error',
      `[${window}] arena_score_inputs_publish_bundle_json call failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const response = await runRpcWithTimeout(query, timeoutMs, window)
  if (!response || typeof response !== 'object') {
    fail('rpc_error', `[${window}] arena_score_inputs_publish_bundle_json returned no envelope`)
  }
  if (response.error !== null && response.error !== undefined) {
    fail(
      'rpc_error',
      `[${window}] arena_score_inputs_publish_bundle_json failed: ${describeRpcError(
        response.error
      )}`
    )
  }
  if (response.data === null || response.data === undefined) {
    fail('rpc_null', `[${window}] arena_score_inputs_publish_bundle_json returned null data`)
  }

  // Nothing below this line runs unless every score row and physical board has
  // passed the strict publication-evidence contract.
  const evidence = parseSourcePublicationEvidence(response.data, {
    window,
    now: options.now,
    maxAgeHours,
  })
  const mapScoreRow = dependencies.mapScoreRow ?? mapArenaScoreRowToTraderRow
  const freshRowCounts = new Map(evidence.freshAliases.map((alias) => [alias.source, 0]))
  const traderRows: TraderRow[] = []

  for (const row of evidence.freshScoreRows) {
    traderRows.push(mapScoreRow(row))
    freshRowCounts.set(row.platform, (freshRowCounts.get(row.platform) ?? 0) + 1)
  }

  return { evidence, traderRows, freshRowCounts }
}
