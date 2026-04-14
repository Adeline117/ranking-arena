/**
 * Unified client-side API fetch with built-in safety:
 * - Checks response.ok (throws on 4xx/5xx)
 * - AbortSignal.timeout (default 15s)
 * - JSON parsing with error context
 * - Type-safe return
 */

export class ApiFetchError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public url: string,
  ) {
    super(`API ${status} ${statusText}: ${url}`)
    this.name = 'ApiFetchError'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function apiFetch<T>(
  url: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options ?? {}

  const response = await fetch(url, {
    ...fetchOptions,
    signal: fetchOptions.signal ?? AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new ApiFetchError(response.status, response.statusText, url)
  }

  return response.json() as Promise<T>
}
