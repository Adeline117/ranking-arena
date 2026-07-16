// Matches `storageKey` in lib/supabase/client.ts. This is only a synchronous
// best-effort client hint; every server endpoint still validates the token.
import { AUTH_STORAGE_KEY } from '@/lib/auth/session-operation'

export function getLocalAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const token = (JSON.parse(raw) as { access_token?: unknown }).access_token
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

export function hasLocalSession(): boolean {
  return getLocalAccessToken() !== null
}
