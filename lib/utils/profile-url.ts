/**
 * Validation for user-supplied profile links (verified/claimed trader
 * twitter/telegram/website/avatar URLs). Only https URLs to public hosts are
 * accepted — `javascript:`, `data:`, plain http, credentials-in-URL and
 * obviously internal hosts are rejected so stored links are safe to render
 * as href/src.
 */

const MAX_PROFILE_URL_LENGTH = 2048
const MAX_HANDLE_LENGTH = 100
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i

export function isSafeProfileUrl(url: string): boolean {
  if (url.length > MAX_PROFILE_URL_LENGTH) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal')
    )
      return false
    return true
  } catch {
    return false
  }
}

export type ProfileFieldResult = { ok: true; value: string | null } | { ok: false }

/**
 * Normalise an optional URL field: non-string / blank → null; otherwise it must
 * pass isSafeProfileUrl.
 */
export function parseOptionalProfileUrl(raw: unknown): ProfileFieldResult {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { ok: true, value: null }
  return isSafeProfileUrl(value) ? { ok: true, value } : { ok: false }
}

/**
 * Discord is stored as a handle ("name#1234" / "name") OR an invite URL. A
 * value carrying any URL scheme must be a safe https URL; handles are length-capped.
 */
export function parseOptionalDiscordHandle(raw: unknown): ProfileFieldResult {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { ok: true, value: null }
  if (SCHEME_PREFIX.test(value)) {
    return isSafeProfileUrl(value) ? { ok: true, value } : { ok: false }
  }
  if (value.length > MAX_HANDLE_LENGTH || /[<>"'`\s]/.test(value)) return { ok: false }
  return { ok: true, value }
}
