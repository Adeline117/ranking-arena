import { fetcher as rawFetcher } from '@/lib/hooks/fetchers'
import { quarantineLegacyPositionHistory } from '@/lib/data/trader/history-quarantine'

function isLegacyTraderDetailUrl(url: string): boolean {
  try {
    return /^\/api\/traders\/[^/]+\/?$/.test(new URL(url, 'http://arena.local').pathname)
  } catch {
    return false
  }
}

/**
 * Shared SWR fetcher for trader detail API.
 * Unwraps the API envelope { success, data } to get raw TraderPageData.
 *
 * Used by:
 * - TraderProfileClient (trader detail page)
 * - useUserProfile (user profile page with linked trader)
 */
export async function traderFetcher<T = unknown>(url: string): Promise<T> {
  const raw = await rawFetcher<T | { success: boolean; data: T }>(url)
  const sanitize = (value: T): T =>
    isLegacyTraderDetailUrl(url) ? quarantineLegacyPositionHistory(value) : value
  // The API wraps responses in { success, data }; unwrap for SWR consumers
  if (raw && typeof raw === 'object' && 'data' in raw && 'success' in raw) {
    return sanitize((raw as { success: boolean; data: T }).data)
  }
  // Fallback: if response is already unwrapped (e.g. direct shape), return as-is
  return sanitize(raw as T)
}
