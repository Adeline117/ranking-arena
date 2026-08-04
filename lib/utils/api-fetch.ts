/**
 * Unified client-side API fetch with built-in safety:
 * - Checks response.ok (throws on 4xx/5xx)
 * - A physical request + JSON deadline (default 15s)
 * - JSON parsing with error context
 * - Type-safe return
 */

export class ApiFetchError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public url: string
  ) {
    super(`API ${status} ${statusText}: ${url}`)
    this.name = 'ApiFetchError'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

function consumePromise(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined
  )
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/**
 * AbortSignal alone only asks a transport to stop. Some fetch shims and body
 * decoders ignore it, so also reject the caller-facing promise when the signal
 * fires while continuing to observe the abandoned work.
 */
function waitWithinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    consumePromise(work)
    return Promise.reject(abortReason(signal))
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export async function apiFetch<T>(
  url: string,
  options?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options ?? {}
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('apiFetch timeoutMs must be a positive finite number')
  }

  const controller = new AbortController()
  const callerSignal = fetchOptions.signal
  const abortFromCaller = () => {
    if (!controller.signal.aborted && callerSignal) {
      controller.abort(abortReason(callerSignal))
    }
  }
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })

  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'))
    }
  }, Math.trunc(timeoutMs))

  try {
    if (controller.signal.aborted) throw abortReason(controller.signal)
    const response = await waitWithinSignal(
      fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      }),
      controller.signal
    )

    if (!response.ok) {
      throw new ApiFetchError(response.status, response.statusText, url)
    }

    return (await waitWithinSignal(response.json(), controller.signal)) as T
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}
