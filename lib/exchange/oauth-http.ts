const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024

export type OAuthJsonResponse = {
  ok: boolean
  status: number
  data: unknown
}

function contentLength(response: Response): number | null {
  const value = response.headers.get('content-length')
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Fetch and consume a small OAuth JSON response under one deadline.
 *
 * The shared fetchWithTimeout helper stops its timer after response headers.
 * OAuth state leases also need the response body read to be bounded, otherwise
 * a provider can send headers and stall JSON forever while the lease expires.
 */
export async function fetchOAuthJsonWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<OAuthJsonResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('OAuth request timeout is invalid')
  }

  const controller = new AbortController()
  const callerSignal = options.signal
  const abortFromCaller = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const declaredBytes = contentLength(response)
    if (declaredBytes !== null && declaredBytes > MAX_OAUTH_RESPONSE_BYTES) {
      controller.abort()
      throw new Error('OAuth response body is too large')
    }

    // The controller remains live until text() completes, so a stalled body is
    // aborted by the same end-to-end deadline as the initial request.
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_OAUTH_RESPONSE_BYTES) {
      throw new Error('OAuth response body is too large')
    }

    let data: unknown = null
    if (text.length > 0) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    return { ok: response.ok, status: response.status, data }
  } finally {
    clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}
