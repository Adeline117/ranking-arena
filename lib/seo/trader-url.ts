/**
 * The single rule for a trader profile's canonical path:
 * `/trader/{exchange-local id}?platform={source}`.
 *
 * Shared by the page's canonical tag, its JSON-LD/breadcrumbs, the server
 * summary's links and the sitemap, so every surface hands crawlers the same URL
 * for one trader.
 *
 * The id, never the display handle. (source, id) is the trader's identity — it
 * is unique and does not change. A handle is neither: two traders on one
 * exchange can share a display name, and a name can be edited, so a canonical
 * built from it could point at a different trader or at nothing. The id form is
 * also what every ranking table and card already links to, so internal links,
 * canonical and sitemap now agree instead of each ranked trader being linked at
 * one URL and declared canonical at another.
 *
 * `?platform=` is part of the identity: the same id exists on several sources
 * and the bare form would merge different traders.
 */
export function traderCanonicalPath(trader: { sourceTraderId: string; source: string }): string {
  return `/trader/${encodeURIComponent(trader.sourceTraderId)}?platform=${encodeURIComponent(trader.source)}`
}
