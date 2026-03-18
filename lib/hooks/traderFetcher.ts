import { fetcher as rawFetcher } from '@/lib/hooks/useSWR'

/**
 * Shared SWR fetcher for trader detail API.
 * Unwraps the API envelope { success, data } to get raw TraderPageData.
 *
 * Used by:
 * - TraderProfileClient (trader detail page)
 * - useUserProfile (user profile page with linked trader)
 */
export async function traderFetcher<T = unknown>(url: string): Promise<T> {
  const raw = await rawFetcher<{ success: boolean; data: T }>(url)
  // The API wraps responses in { success, data }; unwrap for SWR consumers
  if (raw && typeof raw === 'object' && 'data' in raw && 'success' in raw) {
    return (raw as { success: boolean; data: T }).data
  }
  // Fallback: if response is already unwrapped (e.g. direct shape), return as-is
  return raw as unknown as T
}
