import { NULL_DISPLAY } from '@/lib/utils/format'

/**
 * Format a market-data timestamp without depending on the runtime time zone.
 *
 * Client Components render once on the server and again in the browser during
 * hydration. Using the host's local time zone makes those two renders disagree
 * whenever the server and visitor are in different zones. An explicit,
 * locale-independent UTC representation is both hydration-safe and unambiguous
 * for a global market-data product.
 */
export function formatMarketTimeUtc(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return NULL_DISPLAY

  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')

  return `${year}-${month}-${day} ${hour}:${minute} UTC`
}
