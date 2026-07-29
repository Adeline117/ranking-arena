import type { getSupabaseAdmin } from '@/lib/api'
import {
  LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS,
  LEADERBOARD_PUBLICATION_PROOFS_RPC_TIMEOUT_MS,
  type LeaderboardPublicationSeason,
  type ReadPublicationProofsOptions,
} from '@/lib/rankings/read-publication-proofs'
import { parseExpectedSourceWindows } from '@/lib/rankings/source-freshness'

export const LEADERBOARD_PUBLICATION_AUTHORITY_MAX_WINDOWS =
  LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES * 3

const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

type PublicationAuthorityClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'rpc'>

export type ReadPublicationAuthorityErrorCode =
  | 'invalid_input'
  | 'rpc_call_error'
  | 'rpc_error'
  | 'rpc_null'
  | 'rpc_shape_mismatch'
  | 'rpc_aborted'
  | 'rpc_timeout'

export class ReadPublicationAuthorityError extends Error {
  constructor(
    public readonly code: ReadPublicationAuthorityErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ReadPublicationAuthorityError'
  }
}

function fail(
  code: ReadPublicationAuthorityErrorCode,
  message: string,
  options?: ErrorOptions
): never {
  throw new ReadPublicationAuthorityError(code, message, options)
}

function requireSeason(season: LeaderboardPublicationSeason): LeaderboardPublicationSeason {
  if (season !== '7D' && season !== '30D' && season !== '90D') {
    fail('invalid_input', 'publication authority season must be exactly 7D, 30D, or 90D')
  }
  return season
}

function requireOptions(options: ReadPublicationProofsOptions): {
  timeoutMs: number
  signal: AbortSignal | undefined
} {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_input', 'publication authority options must be an object')
  }

  const timeoutMs =
    options.timeoutMs === undefined
      ? LEADERBOARD_PUBLICATION_PROOFS_RPC_TIMEOUT_MS
      : options.timeoutMs
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS
  ) {
    fail(
      'invalid_input',
      `timeoutMs must be a positive safe integer no greater than ${LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS}`
    )
  }
  if (
    options.signal !== undefined &&
    (!(options.signal instanceof AbortSignal) || typeof options.signal.aborted !== 'boolean')
  ) {
    fail('invalid_input', 'signal must be an AbortSignal')
  }
  if (
    options.now !== undefined &&
    (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime()))
  ) {
    fail('invalid_input', 'now must be a valid Date')
  }

  return { timeoutMs, signal: options.signal }
}

async function runAuthorityRpc(
  supabase: PublicationAuthorityClient,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<unknown> {
  if (externalSignal?.aborted) {
    fail('rpc_aborted', 'publication authority read was aborted before dispatch')
  }

  let query: unknown
  try {
    query = supabase.rpc('arena_freshness_expected_sources')
  } catch (error) {
    fail('rpc_call_error', 'publication authority RPC call failed before dispatch', {
      cause: error,
    })
  }

  if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
    fail('rpc_call_error', 'publication authority RPC returned no query')
  }

  const controller = new AbortController()
  let awaitable = query
  try {
    const abortSignal = Reflect.get(query, 'abortSignal')
    if (typeof abortSignal === 'function') {
      awaitable = Reflect.apply(abortSignal, query, [controller.signal])
    }
  } catch (error) {
    fail('rpc_call_error', 'publication authority RPC could not attach its AbortSignal', {
      cause: error,
    })
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeExternalAbortListener: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(
        new ReadPublicationAuthorityError(
          'rpc_timeout',
          `arena_freshness_expected_sources exceeded its ${timeoutMs}ms deadline`
        )
      )
    }, timeoutMs)

    if (externalSignal) {
      const onAbort = () => {
        controller.abort()
        reject(
          new ReadPublicationAuthorityError(
            'rpc_aborted',
            'publication authority read was aborted by caller'
          )
        )
      }
      externalSignal.addEventListener('abort', onAbort, { once: true })
      removeExternalAbortListener = () => {
        externalSignal.removeEventListener('abort', onAbort)
      }
      if (externalSignal.aborted) onAbort()
    }
  })

  try {
    return await Promise.race([Promise.resolve(awaitable), interrupted])
  } catch (error) {
    if (error instanceof ReadPublicationAuthorityError) throw error
    fail('rpc_error', 'publication authority RPC transport failed', { cause: error })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    removeExternalAbortListener?.()
  }
}

function parseAuthoritySources(
  response: unknown,
  season: LeaderboardPublicationSeason
): readonly string[] {
  let data: unknown
  let error: unknown
  try {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      fail('rpc_error', 'publication authority RPC returned no envelope')
    }
    data = Reflect.get(response, 'data')
    error = Reflect.get(response, 'error')
  } catch (cause) {
    if (cause instanceof ReadPublicationAuthorityError) throw cause
    fail('rpc_error', 'publication authority RPC envelope could not be inspected safely', {
      cause,
    })
  }

  if (error !== null && error !== undefined) {
    fail('rpc_error', 'publication authority RPC failed', { cause: error })
  }
  if (data === null || data === undefined) {
    fail('rpc_null', 'publication authority RPC returned null data')
  }
  if (
    !Array.isArray(data) ||
    data.length === 0 ||
    data.length > LEADERBOARD_PUBLICATION_AUTHORITY_MAX_WINDOWS
  ) {
    fail('rpc_shape_mismatch', 'publication authority RPC returned an invalid window count')
  }

  try {
    const sources = [
      ...new Set(
        parseExpectedSourceWindows(data)
          .filter((window) => window.season_id === season)
          .map((window) => window.source)
      ),
    ].sort()

    if (sources.length === 0 || sources.length > LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES) {
      fail('rpc_shape_mismatch', 'publication authority returned no bounded season authority')
    }
    for (const source of sources) {
      if (
        source.length > LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH ||
        !SOURCE_PATTERN.test(source)
      ) {
        fail('rpc_shape_mismatch', 'publication authority contains a non-canonical source')
      }
    }
    return Object.freeze(sources)
  } catch (cause) {
    if (cause instanceof ReadPublicationAuthorityError) throw cause
    fail('rpc_shape_mismatch', 'publication authority response could not be validated', {
      cause,
    })
  }
}

/**
 * Read the dynamic source membership used by the proof RPC for one season.
 *
 * The registry RPC can return multiple physical boards for one public source,
 * so this mirrors the SQL proof contract by returning distinct, C-sorted
 * `filter_source` values.
 */
export async function readLeaderboardPublicationAuthority(
  supabase: PublicationAuthorityClient,
  season: LeaderboardPublicationSeason,
  options: ReadPublicationProofsOptions = {}
): Promise<readonly string[]> {
  const canonicalSeason = requireSeason(season)
  const { timeoutMs, signal } = requireOptions(options)
  const response = await runAuthorityRpc(supabase, timeoutMs, signal)
  return parseAuthoritySources(response, canonicalSeason)
}
