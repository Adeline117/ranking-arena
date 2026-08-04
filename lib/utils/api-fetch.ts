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

type ApiFetchOptions = RequestInit & {
  timeoutMs?: number
  /**
   * A small set of non-2xx statuses whose JSON body is itself authoritative
   * application state (for example a health endpoint's degraded response).
   * Every status must be opted into explicitly; all other non-2xx responses
   * keep the default fail-closed behavior.
   */
  acceptedStatuses?: readonly number[]
}

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

export async function apiFetch<T>(url: string, options?: ApiFetchOptions): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, acceptedStatuses = [], ...fetchOptions } = options ?? {}
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('apiFetch timeoutMs must be a positive finite number')
  }
  if (
    !Array.isArray(acceptedStatuses) ||
    acceptedStatuses.some((status) => !Number.isSafeInteger(status) || status < 100 || status > 599)
  ) {
    throw new TypeError('apiFetch acceptedStatuses must contain valid HTTP status codes')
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

    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      throw new ApiFetchError(response.status, response.statusText, url)
    }

    return (await waitWithinSignal(response.json(), controller.signal)) as T
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}
