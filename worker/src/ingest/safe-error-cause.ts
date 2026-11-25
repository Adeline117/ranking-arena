/**
 * Describes an error that is about to be reported under a fixed failure code,
 * using only fields that cannot carry SQL, connection strings or payloads: the
 * error class, a SQLSTATE / errno-style or fence code, the fence operation and
 * retry policy, and whether it was the pg client's own query timeout. Messages
 * are never included.
 */
const SAFE_CAUSE_TOKEN = /^[A-Za-z0-9_]{2,40}$/

function describeOne(cause: Error): string {
  const fields = cause as { code?: unknown; operation?: unknown; retryPolicy?: unknown }
  const safe = (label: string, value: unknown) =>
    typeof value === 'string' && SAFE_CAUSE_TOKEN.test(value) ? ` ${label}=${value}` : ''
  return (
    (/^[A-Za-z]{1,60}$/.test(cause.name) ? cause.name : 'Error') +
    // SQLSTATE / errno (57014, ECONNRESET) or a fence code (write_deadline_exceeded).
    safe('code', fields.code) +
    safe('operation', fields.operation) +
    safe('retry', fields.retryPolicy) +
    (cause.message === 'Query read timeout' ? ' query_read_timeout' : '')
  )
}

/** Outermost first, following `cause` at most four levels deep. */
export function describeSafeCauseChain(cause: unknown): string {
  const chain: string[] = []
  for (let current: unknown = cause, depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) break
    chain.push(describeOne(current))
    current = (current as { cause?: unknown }).cause
  }
  return chain.length > 0 ? chain.join(' <- ') : `non-error rejection (${typeof cause})`
}
