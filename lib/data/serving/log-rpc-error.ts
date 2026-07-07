import logger from '@/lib/logger'

/**
 * Log a serving-RPC error before the caller folds it into a null/empty return.
 *
 * The Arena footgun: an RPC error (schema drift, a missing/renamed function,
 * 42703 wrong column) folded into `return null` is indistinguishable from a
 * genuinely-empty result — so a broken serving RPC silently blanks charts,
 * stats and boards for ~all traders, invisible to users AND ops. Call this on
 * the `error` branch so the drift surfaces in logs; the caller keeps its
 * null/empty return (cold-miss semantics) unchanged.
 */
export function logRpcError(
  rpc: string,
  error: { message?: string; code?: string; details?: string } | null | undefined
): void {
  if (!error) return
  logger.error(`[serving] RPC ${rpc} failed`, {
    code: error.code,
    message: error.message,
    details: error.details,
  })
}
