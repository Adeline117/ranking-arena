export const TWO_FACTOR_MAX_REQUEST_BYTES = 32 * 1024

export const TWO_FACTOR_SECRET_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
} as const

export type TwoFactorJsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid' | 'too_large' }

function declaredBodyLength(request: Request): number | null | 'invalid' {
  const raw = request.headers.get('content-length')
  // Native Headers returns null; lightweight route-test doubles commonly
  // return undefined for a missing header.
  if (raw == null) return null
  const length = Number(raw)
  return Number.isSafeInteger(length) && length >= 0 ? length : 'invalid'
}

async function readStreamBody(request: Request): Promise<TwoFactorJsonReadResult> {
  if (!request.body) return { ok: false, reason: 'invalid' }
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > TWO_FACTOR_MAX_REQUEST_BYTES) {
        await reader.cancel()
        return { ok: false, reason: 'too_large' }
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/** Reads JSON without trusting Content-Length; the fallback supports route unit-test request doubles. */
export async function readTwoFactorJson(request: Request): Promise<TwoFactorJsonReadResult> {
  const declaredLength = declaredBodyLength(request)
  if (declaredLength === 'invalid') return { ok: false, reason: 'invalid' }
  if (declaredLength !== null && declaredLength > TWO_FACTOR_MAX_REQUEST_BYTES) {
    return { ok: false, reason: 'too_large' }
  }

  if (request.body && typeof request.body.getReader === 'function') {
    return readStreamBody(request)
  }

  try {
    const value: unknown = await request.json()
    const encoded = new TextEncoder().encode(JSON.stringify(value))
    return encoded.byteLength > TWO_FACTOR_MAX_REQUEST_BYTES
      ? { ok: false, reason: 'too_large' }
      : { ok: true, value }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/** Setup/rotation carry no client input and reject any request payload. */
export async function hasExactEmptyTwoFactorBody(request: Request): Promise<boolean> {
  const declaredLength = declaredBodyLength(request)
  if (declaredLength === 'invalid' || (declaredLength !== null && declaredLength !== 0)) {
    return false
  }

  if (request.body && typeof request.body.getReader === 'function') {
    const reader = request.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return true
        if (chunk.value.byteLength > 0) {
          await reader.cancel()
          return false
        }
      }
    } catch {
      return false
    }
  }

  try {
    return (await request.json()) === undefined
  } catch {
    return true
  }
}
