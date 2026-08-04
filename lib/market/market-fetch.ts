export const MARKET_REQUEST_TIMEOUT_MS = 15_000

export class MarketHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string
  ) {
    super(`Market request failed with HTTP ${status}: ${url}`)
    this.name = 'MarketHttpError'
  }
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

export interface MarketJsonResponse {
  headers: Headers
  value: unknown
}

export async function fetchMarketJson(
  url: string,
  options: RequestInit & {
    callerSignal?: AbortSignal
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {}
): Promise<MarketJsonResponse> {
  const {
    callerSignal,
    fetchImpl = fetch,
    timeoutMs = MARKET_REQUEST_TIMEOUT_MS,
    ...requestInit
  } = options

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Market request timeout must be a positive finite number')
  }

  const controller = new AbortController()
  const abortFromCaller = () => {
    if (!controller.signal.aborted && callerSignal) {
      controller.abort(abortReason(callerSignal))
    }
  }
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })

  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('The market request timed out', 'TimeoutError'))
    }
  }, Math.trunc(timeoutMs))

  try {
    if (controller.signal.aborted) throw abortReason(controller.signal)

    const response = await waitWithinSignal(
      fetchImpl(url, {
        ...requestInit,
        signal: controller.signal,
      }),
      controller.signal
    )

    if (response.status !== 200) {
      throw new MarketHttpError(response.status, url)
    }

    const value = await waitWithinSignal(response.json(), controller.signal)
    return { headers: response.headers, value }
  } finally {
    clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}
