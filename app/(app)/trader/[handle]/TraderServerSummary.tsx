/**
 * Server-rendered performance summary for a trader profile.
 *
 * Every tab body in TraderProfileClient is `ssr: false` and fills in from
 * /api/* (which robots.txt disallows), so the server HTML of a profile used to
 * carry only the header: a name and an exchange. A crawler — and a reader
 * before hydration — saw thirty thousand pages that differed by one string.
 *
 * This block puts the numbers the server has ALREADY resolved for the header
 * (sealed public-cohort rank / ROI / PnL / win rate / drawdown / Arena Score)
 * and the similar-trader links into the HTML as real, visible content. It adds
 * no query. page.tsx passes it to TraderProfileClient as a node, which places
 * it inside the profile container above the data disclaimer. When there is
 * nothing to show it renders nothing — never an empty
 * shell or placeholder dashes.
 */
import { tokens } from '@/lib/design-tokens'
import { formatDrawdown, formatPnL, formatROI } from '@/lib/utils/format'

export interface TraderSummaryMetrics {
  rank?: number | null
  arenaScore?: number | null
  roi?: number | null
  pnl?: number | null
  winRate?: number | null
  maxDrawdown?: number | null
}

export interface TraderSummarySimilar {
  name: string
  href: string
  roi?: number | null
  arenaScore?: number | null
}

export interface TraderSummaryRow {
  key: string
  label: string
  value: string
  tone?: 'positive' | 'negative'
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const signTone = (value: number): 'positive' | 'negative' => (value >= 0 ? 'positive' : 'negative')

/** Only real values become rows: a missing metric is absent, not "—". */
export function buildTraderSummaryRows(
  metrics: TraderSummaryMetrics,
  t: (key: string) => string
): TraderSummaryRow[] {
  const rows: TraderSummaryRow[] = []
  if (finite(metrics.rank) && metrics.rank > 0) {
    rows.push({ key: 'rank', label: t('rank'), value: `#${Math.trunc(metrics.rank)}` })
  }
  if (finite(metrics.arenaScore)) {
    rows.push({ key: 'score', label: t('arenaScore'), value: metrics.arenaScore.toFixed(1) })
  }
  if (finite(metrics.roi)) {
    rows.push({
      key: 'roi',
      label: t('roi'),
      value: formatROI(metrics.roi),
      tone: signTone(metrics.roi),
    })
  }
  if (finite(metrics.pnl)) {
    rows.push({
      key: 'pnl',
      label: t('pnl'),
      value: formatPnL(metrics.pnl),
      tone: signTone(metrics.pnl),
    })
  }
  if (finite(metrics.winRate)) {
    rows.push({ key: 'win', label: t('winRate'), value: `${metrics.winRate.toFixed(1)}%` })
  }
  if (finite(metrics.maxDrawdown)) {
    rows.push({ key: 'mdd', label: t('maxDrawdown'), value: formatDrawdown(metrics.maxDrawdown) })
  }
  return rows
}

const CLOCK_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' }

/** "Public leaderboard data · {exchange} · as of {UTC time}" (time only if known). */
export function summaryDataNote({
  exchange,
  dataAsOf,
  language,
  t,
}: {
  exchange: string
  dataAsOf?: string | null
  language: string
  t: (key: string) => string
}): string {
  const parts = [t('publicLeaderboardData'), exchange]
  const ms = dataAsOf ? Date.parse(dataAsOf) : Number.NaN
  if (Number.isFinite(ms)) {
    const clock = new Intl.DateTimeFormat(CLOCK_LOCALE[language] ?? 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }).format(new Date(ms))
    parts.push(t('rowDataAsOf').replace('{time}', clock))
  }
  return parts.join(' · ')
}

const TONE_COLOR = {
  positive: 'var(--color-accent-success)',
  negative: 'var(--color-accent-error)',
} as const

export default function TraderServerSummary({
  name,
  exchange,
  windowLabel,
  metrics,
  similar,
  t,
  dataAsOf,
  language = 'en',
  idleWindow = false,
}: {
  name: string
  exchange: string
  /** Already-localized window label ("90D"). */
  windowLabel: string
  metrics: TraderSummaryMetrics
  similar: TraderSummarySimilar[]
  t: (key: string) => string
  /**
   * When the exchange data behind these numbers was captured (ISO). Shown in
   * the data note; omitted from it when unknown — never replaced by "now".
   */
  dataAsOf?: string | null
  /** UI language, for the capture-time format. */
  language?: string
  /**
   * The account is ranked in this window but did no trading (idle window). It
   * has no score: the summary says so and never prints one, whatever `metrics`
   * carries.
   */
  idleWindow?: boolean
}) {
  const rows = buildTraderSummaryRows(idleWindow ? { ...metrics, arenaScore: null } : metrics, t)
  if (rows.length === 0 && similar.length === 0 && !idleWindow) return null

  return (
    <section aria-labelledby="trader-summary-heading" style={{ marginTop: tokens.spacing[8] }}>
      <div
        style={{
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          paddingTop: tokens.spacing[6],
        }}
      >
        <h2
          id="trader-summary-heading"
          style={{
            margin: 0,
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: tokens.typography.fontWeight.semibold,
            color: tokens.colors.text.primary,
          }}
        >
          {/* No trader name here: the profile's <h1> is the only heading that names
              the trader (tests and screen readers locate the page by it). */}
          {t('traderSummaryHeading')}
        </h2>

        {idleWindow && (
          <p
            data-testid="trader-summary-idle"
            style={{
              margin: `${tokens.spacing[2]} 0 0`,
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
            }}
          >
            {t('noTradingThisPeriod')}
          </p>
        )}

        {rows.length > 0 && (
          <>
            <p
              style={{
                margin: `${tokens.spacing[2]} 0 0`,
                fontSize: tokens.typography.fontSize.sm,
                color: tokens.colors.text.secondary,
              }}
            >
              {t('traderSummaryLead')
                .replace('{name}', name)
                .replace('{window}', windowLabel)
                .replace('{exchange}', exchange)}
            </p>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
                gap: tokens.spacing[4],
                margin: `${tokens.spacing[4]} 0 0`,
              }}
            >
              {rows.map((row) => (
                <div key={row.key}>
                  <dt
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.tertiary,
                    }}
                  >
                    {row.label}
                  </dt>
                  <dd
                    style={{
                      margin: `${tokens.spacing[1]} 0 0`,
                      fontSize: tokens.typography.fontSize.md,
                      fontWeight: tokens.typography.fontWeight.semibold,
                      fontVariantNumeric: 'tabular-nums',
                      color: row.tone ? TONE_COLOR[row.tone] : tokens.colors.text.primary,
                    }}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            {/* Data level (L1): these are public leaderboard figures, from this
                exchange, as of the capture time when it is known. */}
            <p
              data-testid="trader-summary-data-note"
              style={{
                margin: `${tokens.spacing[3]} 0 0`,
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
              }}
            >
              {summaryDataNote({ exchange, dataAsOf, language, t })}
            </p>
          </>
        )}

        {similar.length > 0 && (
          <nav aria-labelledby="trader-summary-similar" style={{ marginTop: tokens.spacing[6] }}>
            <h3
              id="trader-summary-similar"
              style={{
                margin: 0,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
                color: tokens.colors.text.secondary,
              }}
            >
              {t('similarTraders')}
            </h3>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: `${tokens.spacing[3]} 0 0`,
                display: 'flex',
                flexWrap: 'wrap',
                gap: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
              }}
            >
              {similar.map((trader) => (
                <li key={trader.href} style={{ fontSize: tokens.typography.fontSize.sm }}>
                  <a
                    href={trader.href}
                    style={{ color: tokens.colors.text.primary, textDecoration: 'none' }}
                  >
                    {trader.name}
                  </a>
                  {finite(trader.roi) && (
                    <span
                      style={{
                        marginLeft: tokens.spacing[2],
                        fontVariantNumeric: 'tabular-nums',
                        color: TONE_COLOR[signTone(trader.roi)],
                      }}
                    >
                      {formatROI(trader.roi)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </section>
  )
}
