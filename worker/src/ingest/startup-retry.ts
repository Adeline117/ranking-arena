const TRANSIENT_DEPENDENCY_ERROR =
  /connection (?:terminated|closed|refused)|connection to database not available|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECIRCUITBREAKER|EAUTHQUERY|temporarily blocked|failed to retrieve database credentials|authentication query failed|fetch failed|timed? ?out|HTTP 5\d\d|57P01|53300|08P01/i

export function isTransientDependencyError(error: unknown): boolean {
  const parts: string[] = []
  let current: unknown = error
  const seen = new Set<unknown>()

  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }

  return TRANSIENT_DEPENDENCY_ERROR.test(parts.join(' '))
}

interface RetryOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  sleep?: (milliseconds: number) => Promise<void>
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

export async function retryTransientStartup<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 2_000
  const maxDelayMs = options.maxDelayMs ?? 60_000
  const sleep = options.sleep ?? ((milliseconds) => defaultSleep(milliseconds, options.signal))
  let attempt = 0

  for (;;) {
    options.signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      options.signal?.throwIfAborted()
      if (!isTransientDependencyError(error)) throw error

      attempt += 1
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 10))
      options.onRetry?.(error, attempt, delayMs)
      await sleep(delayMs)
    }
  }
}
