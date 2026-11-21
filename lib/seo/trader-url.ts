/**
 * The single rule for a trader profile's canonical path.
 *
 * Shared by the page's canonical tag, its JSON-LD/breadcrumbs, and the sitemap,
 * so every surface hands crawlers the same URL for one trader. They used to each
 * build their own: the sitemap always used the handle, the canonical used the
 * exchange-local id for non-ASCII handles, and JSON-LD dropped `?platform=`.
 *
 * - ASCII handles stay as the readable path segment.
 * - Anything else uses the stable exchange-local id (encoded multi-byte paths
 *   have been rejected at the edge before).
 * - `?platform=` is part of the identity: the same handle/id exists on several
 *   sources and the bare form would merge different traders.
 */
const READABLE_HANDLE = /^[a-zA-Z0-9_.-]+$/

export function traderCanonicalPath(trader: {
  handle?: string | null
  sourceTraderId: string
  source: string
}): string {
  const segment =
    trader.handle && READABLE_HANDLE.test(trader.handle) ? trader.handle : trader.sourceTraderId
  return `/trader/${encodeURIComponent(segment)}?platform=${encodeURIComponent(trader.source)}`
}
