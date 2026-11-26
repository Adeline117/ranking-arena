/**
 * The data-level note every ranking row carries (plan §3.1, level L1):
 * "Public leaderboard data · {exchange} · as of {time}".
 *
 * `asOf` is the SOURCE watermark — when the exchange data behind the row was
 * captured (leaderboard_source_freshness.source_as_of) — never Arena's own
 * re-score time. Returns null when that time is unknown: a row then shows no
 * note at all rather than a guessed or relative-to-now one.
 */
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'

const CLOCK_LOCALE: Record<string, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
}

export interface RowProvenance {
  /** Compact text for the row itself, e.g. "3h ago". */
  short: string
  /** Full sentence for the tooltip / accessible description. */
  full: string
  /** Machine-readable capture time. */
  iso: string
}

export function describeRowProvenance(
  input: { source?: string | null; asOf?: string | null },
  t: (key: string) => string,
  language: string
): RowProvenance | null {
  if (!input.asOf) return null
  const ms = Date.parse(input.asOf)
  if (!Number.isFinite(ms)) return null
  const clock = new Intl.DateTimeFormat(CLOCK_LOCALE[language] ?? 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(ms))
  const exchange = input.source ? EXCHANGE_NAMES[input.source.toLowerCase()] || input.source : null
  return {
    short: formatTimeAgo(input.asOf, language as Locale),
    full: [t('publicLeaderboardData'), exchange, t('rowDataAsOf').replace('{time}', clock)]
      .filter(Boolean)
      .join(' · '),
    iso: new Date(ms).toISOString(),
  }
}
