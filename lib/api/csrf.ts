/**
 * Lightweight CSRF token helper — zero external dependencies.
 *
 * Extracted from lib/api/client.ts so modules that only need CSRF headers
 * (e.g. quiz) don't pull in the full API client (logger, token-refresh, etc.).
 */

const CSRF_COOKIE_NAME = 'csrf-token'
const CSRF_HEADER_NAME = 'x-csrf-token'

function getCsrfTokenFromCookie(): string | null {
  if (typeof document === 'undefined') return null
  const cookies = document.cookie.split(';')
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=')
    if (name === CSRF_COOKIE_NAME) return decodeURIComponent(value)
  }
  return null
}

function setCsrfTokenCookie(token: string): void {
  if (typeof document === 'undefined') return
  const maxAge = 24 * 60 * 60
  let s = `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; path=/; max-age=${maxAge}; samesite=strict`
  if (process.env.NODE_ENV === 'production') s += '; secure'
  document.cookie = s
}

function generateClientCsrfToken(): string {
  const timestamp = Date.now().toString(36)
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${timestamp}.${randomPart}`
}

function ensureCsrfToken(): string | null {
  if (typeof document === 'undefined') return null
  let token = getCsrfTokenFromCookie()
  if (!token) {
    token = generateClientCsrfToken()
    setCsrfTokenCookie(token)
  }
  return token
}

export function getCsrfHeaders(): Record<string, string> {
  const token = ensureCsrfToken()
  if (!token) return {}
  return { [CSRF_HEADER_NAME]: token }
}
