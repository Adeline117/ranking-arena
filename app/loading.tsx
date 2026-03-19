/**
 * Homepage loading state — intentionally minimal.
 *
 * Why this is empty:
 * - page.tsx fetches all data server-side via getInitialTraders() + getHeroStats()
 * - Both are wrapped in unstable_cache (ISR), so they resolve in <10ms from cache
 * - The SSR shell (HomeHeroSSR + SSRRankingTable) is rendered immediately in page.tsx
 *
 * A full skeleton here (loading.tsx) was the ROOT CAUSE of LCP 9.5s:
 * 1. Browser paints skeleton as initial FCP (large painted area = LCP candidate)
 * 2. Real content arrives via streaming ($RC swap) but skeleton already "won" LCP
 * 3. HomeHero renders client-side at ~9s, updates LCP to hero headline
 *
 * With null loading: browser paints the real SSR content immediately.
 * LCP = hero headline in SSR HTML = sub 2s.
 */
export default function HomeLoading() {
  return null
}
