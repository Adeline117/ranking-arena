/**
 * Shallow URL replacement for trader-detail UI state (?period= / ?tab= /
 * ?account=).
 *
 * The trader page is `revalidate = 0` and its server component does NOT read
 * searchParams, so `router.replace()` only cost a full RSC round-trip +
 * re-render for state that lives entirely on the client. Next.js (>=14.1)
 * patches `history.replaceState` and syncs `useSearchParams()` consumers, so
 * the URL stays authoritative without a server request — same approach as
 * app/components/home/useRankingFilters.ts.
 */
export function replaceUrlShallow(url: string): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(null, '', url)
}
