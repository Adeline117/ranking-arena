import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { EXCHANGE_CONFIG, resolveExchangeSlug } from '@/lib/constants/exchanges'
import { TOP_EXCHANGE_SLUGS } from '@/lib/constants/exchange-slugs'
import { isRetiredSource } from '@/lib/constants/retired-sources'
import { BASE_URL } from '@/lib/constants/urls'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import PageHeader from '@/app/components/ui/PageHeader'
import { formatDisplayName } from '@/app/components/ranking/utils'
import { getServerTranslation } from '@/lib/i18n/server'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import {
  generateExchangeCollectionPageSchema,
  generateBreadcrumbSchema,
  type ExchangeSchemaInput,
} from '@/lib/seo/structured-data'

// Request-rendered so an in-flight pre-publication ISR render cannot repopulate
// stale ranked traders after the publisher revalidates this path.
export const dynamic = 'force-dynamic'

export function generateStaticParams() {
  return TOP_EXCHANGE_SLUGS.map((slug) => ({ slug }))
}

// Allow non-pre-rendered slugs to render at runtime
export const dynamicParams = true

/**
 * Create a fresh Supabase client for exchange page data fetching.
 * Same pattern as sitemap.ts — avoids stale build-time singletons.
 */
function getExchangeSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return createClient<Database>(url || '', key || '', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? AbortSignal.timeout(10_000)
        return globalThis.fetch(input, { ...init, signal })
      },
    },
  })
}

interface ExchangeData {
  displayName: string
  sourceKey: string
  sourceType: string
  /**
   * Exact only when the public cohort count query succeeds. `null` is an
   * explicit unknown, never a visible-page lower bound or an estimated count.
   */
  traderCount: number | null
  topTraders: Array<{
    // Human-readable label (truncated wallet / real handle) — never a fabricated "Trader N".
    displayName: string
    // Value to build the /trader/<id> link from; empty string when no valid target exists.
    linkTarget: string
    // Stable unique identity (composite key) used for React keys.
    sourceTraderId: string
    arena_score: number | null
    roi: number | null
    pnl: number | null
    rank: number
  }>
}

const PUBLIC_RANKED_EXCHANGE_COLUMNS =
  'source,source_trader_id,handle,arena_score,roi,pnl,win_rate,max_drawdown,rank,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hasPositivePublishedRank(row: unknown, sourceKey: string): row is Record<string, unknown> {
  return (
    isRecord(row) &&
    row.source === sourceKey &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0
  )
}

function exactCountOrUnknown(
  result: { count: number | null; error: unknown },
  minimumVisibleRows: number
): number | null {
  const count = result.count
  if (
    result.error ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count < minimumVisibleRows
  ) {
    return null
  }
  return count
}

async function fetchExchangeData(sourceKey: string): Promise<ExchangeData | null> {
  const config = EXCHANGE_CONFIG[sourceKey as keyof typeof EXCHANGE_CONFIG]
  if (!config) return null
  if (!isPublicRankingSourceAllowed(sourceKey)) {
    // A known exchange may still be quarantined or retired from the public
    // ranking contract. Do not probe its retained/raw observations here.
    return {
      displayName: config.name,
      sourceKey,
      sourceType: config.sourceType,
      traderCount: null,
      topTraders: [],
    }
  }

  const publicCohort = getExchangeSupabase()

  // "N ranked traders" counts traders with performance in the period, the
  // same population as the homepage count (get_hero_stats). Idle-window rows
  // (no ROI and no PnL) are left out of the count AND of the top list: the two
  // queries must share one predicate, because a count smaller than the rows
  // shown is treated as unknown (exactCountOrUnknown).
  const [topResult, countResult] = await Promise.all([
    publicCohort
      .from('public_ranked_leaderboard')
      .select(PUBLIC_RANKED_EXCHANGE_COLUMNS)
      .eq('source', sourceKey)
      .eq('season_id', '90D')
      .not('rank', 'is', null)
      .eq('idle_window', false)
      .order('arena_score', { ascending: false, nullsFirst: false })
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(10),
    publicCohort
      .from('public_ranked_leaderboard')
      .select('*', { count: 'exact', head: true })
      .eq('source', sourceKey)
      .eq('season_id', '90D')
      .not('rank', 'is', null)
      .eq('idle_window', false),
  ])

  const rawTopTraders = Array.isArray(topResult.data) ? topResult.data : []
  const sanitized = sanitizePublicRankingPayload(
    { traders: rawTopTraders, period: '90D' },
    { expectedPeriod: '90D' }
  ) as { traders?: unknown[] }
  const safeTopTraders = Array.isArray(sanitized.traders)
    ? sanitized.traders.filter((row) => hasPositivePublishedRank(row, sourceKey))
    : ([] as Record<string, unknown>[])

  // The database view makes this mismatch impossible in a healthy deployment.
  // If an older proxy/schema layer returns a row that fails its public proof,
  // suppress the complete preview rather than silently promoting later rows.
  const topCohortVerified = !topResult.error && safeTopTraders.length === rawTopTraders.length
  const topTraders = (topCohortVerified ? safeTopTraders : []).slice(0, 10).map((t) => {
    const sourceTraderId = typeof t.source_trader_id === 'string' ? t.source_trader_id : ''
    // Prefer the real handle; fall back to the wallet address (never a fabricated
    // "Trader N" that would link to a non-existent /trader/Trader%20N page).
    const linkTarget = typeof t.handle === 'string' ? t.handle : sourceTraderId
    return {
      displayName: linkTarget ? formatDisplayName(linkTarget, sourceKey) : `#${t.rank}`,
      linkTarget,
      sourceTraderId,
      arena_score: finiteOrNull(t.arena_score),
      roi: finiteOrNull(t.roi),
      pnl: finiteOrNull(t.pnl),
      rank: Number(t.rank),
    }
  })

  return {
    displayName: config.name,
    sourceKey,
    sourceType: config.sourceType,
    traderCount: exactCountOrUnknown(countResult, topTraders.length),
    topTraders,
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const sourceKey = resolveExchangeSlug(slug)
  const config = EXCHANGE_CONFIG[sourceKey as keyof typeof EXCHANGE_CONFIG]

  // 已退役来源没有任何数据，落地页只会是空壳（软 404），直接 404。
  if (!config || isRetiredSource(sourceKey)) {
    notFound()
  }

  const displayName = config.name
  const data = await fetchExchangeData(sourceKey).catch(() => null)
  const traderCount = data?.traderCount ?? null
  const topTrader = data?.topTraders?.[0]

  // Root layout template appends ' | Arena' to the metadata title; keep it out
  // here to avoid a doubled '… | Arena | Arena'. OG/Twitter bypass the template.
  const title = `${displayName} Top Traders & Rankings`
  const ogTitle = `${title} | Arena`
  const description =
    traderCount !== null && traderCount > 0
      ? `Explore ${traderCount.toLocaleString()} ranked ${displayName} traders on Arena. ${topTrader ? `Top trader: ${topTrader.displayName}${topTrader.roi != null ? ` (${topTrader.roi >= 0 ? '+' : ''}${topTrader.roi.toFixed(1)}% ROI)` : ''}.` : ''} Compare Arena Scores, ROI, PnL, and risk metrics.`
      : `View ${displayName} crypto trader rankings on Arena. Compare performance, Arena Scores, ROI, and PnL across top traders.`

  const ogImageUrl = `${BASE_URL}/api/og/exchange?exchange=${encodeURIComponent(sourceKey)}`
  // 下划线与连字符两种写法都能访问，规范网址统一成连字符形式。
  const canonicalUrl = `${BASE_URL}/exchange/${slug.replace(/_/g, '-')}`

  return {
    title,
    description,
    openGraph: {
      title: ogTitle,
      description,
      url: canonicalUrl,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${displayName} trader rankings on Arena`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description: description.length > 160 ? description.substring(0, 157) + '...' : description,
      images: [ogImageUrl],
      creator: '@arenafi',
      site: '@arenafi',
    },
    alternates: { canonical: canonicalUrl },
  }
}

function formatRoi(roi: number): string {
  const sign = roi >= 0 ? '+' : ''
  if (Math.abs(roi) >= 10000) return `${sign}${(roi / 1000).toFixed(0)}K%`
  if (Math.abs(roi) >= 1000) return `${sign}${(roi / 1000).toFixed(1)}K%`
  return `${sign}${roi.toFixed(1)}%`
}

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? '+' : ''
  if (Math.abs(pnl) >= 1_000_000) return `${sign}$${(pnl / 1_000_000).toFixed(1)}M`
  if (Math.abs(pnl) >= 1000) return `${sign}$${(pnl / 1000).toFixed(1)}K`
  return `${sign}$${pnl.toFixed(0)}`
}

export default async function ExchangeLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const sourceKey = resolveExchangeSlug(slug)
  const config = EXCHANGE_CONFIG[sourceKey as keyof typeof EXCHANGE_CONFIG]

  // 已退役来源没有任何数据，落地页只会是空壳（软 404），直接 404。
  if (!config || isRetiredSource(sourceKey)) {
    notFound()
  }

  const data = await fetchExchangeData(sourceKey)
  const canonicalSlug = slug.replace(/_/g, '-')

  if (!data) {
    // Fallback: redirect to homepage with exchange filter if data fetch fails
    redirect(`/?ex=${encodeURIComponent(sourceKey)}`)
  }

  // JSON-LD structured data
  // Schema.org `numberOfItems` must be a real total, not the ten-row preview.
  // When the exact public-view count is unavailable, omit this count-bearing
  // schema rather than publishing a synthetic coverage claim.
  // No ranked row means the source has no published board right now (withdrawn,
  // empty, or not publicly rankable): the page says so in words instead of
  // "0 ranked traders" / "Unknown ranked traders", and publishes no
  // count-bearing schema. Rows with an unknown total keep the "unknown" wording.
  const boardEmpty = data.topTraders.length === 0
  const publishedCount = boardEmpty ? null : data.traderCount
  const collectionPageJsonLd =
    publishedCount === null
      ? null
      : generateExchangeCollectionPageSchema({
          name: data.displayName,
          slug: canonicalSlug,
          sourceType: data.sourceType,
          traderCount: publishedCount,
          topTraders: data.topTraders.map((t) => ({
            handle: t.displayName,
            arenaScore: t.arena_score,
            roi: t.roi,
          })),
        } satisfies ExchangeSchemaInput)
  const breadcrumbJsonLd = generateBreadcrumbSchema([
    { name: 'Arena', url: BASE_URL },
    { name: 'Rankings', url: `${BASE_URL}/` },
    { name: `${data.displayName} Rankings`, url: `${BASE_URL}/exchange/${canonicalSlug}` },
  ])

  // Localized page chrome (labels/headings/body). Metadata above stays English
  // for stable SEO/OG; visible page content follows the visitor's language.
  const { t } = await getServerTranslation()
  const sourceTypeLabel =
    data.sourceType === 'futures'
      ? t('exchangePageTypeFutures')
      : data.sourceType === 'spot'
        ? t('exchangePageTypeSpot')
        : t('exchangePageTypeDefi')

  const fillCopy = (publishedKey: string, emptyKey: string) =>
    t(boardEmpty ? emptyKey : publishedKey)
      .replace(
        '{count}',
        data.traderCount === null ? t('dataUnknown') : data.traderCount.toLocaleString()
      )
      .replace(/\{name\}/g, data.displayName)
      .replace('{type}', sourceTypeLabel)

  return (
    <>
      {collectionPageJsonLd ? <JsonLd data={collectionPageJsonLd} /> : null}
      <JsonLd data={breadcrumbJsonLd} />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 16px' }}>
        {/* Header */}
        <PageHeader
          title={t('exchangePageTitle').replace('{name}', data.displayName)}
          subtitle={fillCopy('exchangePageSubtitle', 'exchangePageSubtitleEmpty')}
        />

        {/* Top traders table */}
        {data.topTraders.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2
              style={{
                fontSize: 18,
                fontWeight: 700,
                margin: '0 0 16px',
                color: 'var(--text-primary, #fff)',
              }}
            >
              {t('exchangePageTop10')}
            </h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                    <th
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        color: 'var(--text-secondary, rgba(255,255,255,0.5))',
                        fontWeight: 600,
                        fontSize: 12,
                        letterSpacing: '0.5px',
                      }}
                    >
                      {t('exchangePageColRank')}
                    </th>
                    <th
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        color: 'var(--text-secondary, rgba(255,255,255,0.5))',
                        fontWeight: 600,
                        fontSize: 12,
                        letterSpacing: '0.5px',
                      }}
                    >
                      {t('exchangePageColTrader')}
                    </th>
                    <th
                      style={{
                        textAlign: 'right',
                        padding: '10px 12px',
                        color: 'var(--text-secondary, rgba(255,255,255,0.5))',
                        fontWeight: 600,
                        fontSize: 12,
                        letterSpacing: '0.5px',
                      }}
                    >
                      {t('exchangePageColScore')}
                    </th>
                    <th
                      style={{
                        textAlign: 'right',
                        padding: '10px 12px',
                        color: 'var(--text-secondary, rgba(255,255,255,0.5))',
                        fontWeight: 600,
                        fontSize: 12,
                        letterSpacing: '0.5px',
                      }}
                    >
                      {t('exchangePageColRoi')}
                    </th>
                    <th
                      style={{
                        textAlign: 'right',
                        padding: '10px 12px',
                        color: 'var(--text-secondary, rgba(255,255,255,0.5))',
                        fontWeight: 600,
                        fontSize: 12,
                        letterSpacing: '0.5px',
                      }}
                    >
                      {t('exchangePageColPnl')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topTraders.map((trader) => (
                    <tr
                      key={trader.sourceTraderId || trader.rank}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                    >
                      <td
                        style={{
                          padding: '12px',
                          color: 'var(--text-secondary, rgba(255,255,255,0.6))',
                          fontWeight: 600,
                        }}
                      >
                        #{trader.rank}
                      </td>
                      <td style={{ padding: '12px' }}>
                        {trader.linkTarget ? (
                          <a
                            href={`/trader/${encodeURIComponent(trader.linkTarget)}?platform=${encodeURIComponent(sourceKey)}`}
                            style={{
                              color: 'var(--text-primary, #fff)',
                              fontWeight: 600,
                              textDecoration: 'none',
                            }}
                          >
                            {trader.displayName}
                          </a>
                        ) : (
                          <span style={{ color: 'var(--text-primary, #fff)', fontWeight: 600 }}>
                            {trader.displayName}
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: '12px',
                          textAlign: 'right',

                          color: 'var(--color-rank-gold)',
                          fontWeight: 700,
                        }}
                      >
                        {trader.arena_score != null ? Math.round(trader.arena_score) : '--'}
                      </td>
                      <td
                        style={{
                          padding: '12px',
                          textAlign: 'right',
                          fontWeight: 600,
                          color:
                            trader.roi != null
                              ? trader.roi >= 0
                                ? 'var(--color-accent-success)'
                                : 'var(--color-accent-error)'
                              : 'var(--text-secondary, rgba(255,255,255,0.5))',
                        }}
                      >
                        {trader.roi != null ? formatRoi(trader.roi) : '--'}
                      </td>
                      <td
                        style={{
                          padding: '12px',
                          textAlign: 'right',
                          fontWeight: 600,
                          color:
                            trader.pnl != null
                              ? trader.pnl >= 0
                                ? 'var(--color-accent-success)'
                                : 'var(--color-accent-error)'
                              : 'var(--text-secondary, rgba(255,255,255,0.5))',
                        }}
                      >
                        {trader.pnl != null ? formatPnl(trader.pnl) : '--'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CTA */}
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <a
            href={`/?ex=${encodeURIComponent(sourceKey)}`}
            style={{
              display: 'inline-block',
              padding: '12px 32px',
              borderRadius: 8,
              // eslint-disable-next-line no-restricted-syntax -- vivid CTA gradient by design (no token equivalent)
              background: 'linear-gradient(135deg, #8B5CF6, #6366f1)',
              color: 'var(--color-on-accent)',
              fontWeight: 700,
              fontSize: 15,
              textDecoration: 'none',
            }}
          >
            {t('exchangePageCta').replace('{name}', data.displayName)}
          </a>
        </div>

        {/* SEO content block */}
        <div
          style={{
            marginTop: 32,
            padding: '24px 0',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <h2
            style={{
              fontSize: 16,
              fontWeight: 700,
              margin: '0 0 12px',
              color: 'var(--text-primary, #fff)',
            }}
          >
            {t('exchangePageAboutTitle').replace('{name}', data.displayName)}
          </h2>
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.7,
              color: 'var(--text-secondary, rgba(255,255,255,0.6))',
              margin: 0,
            }}
          >
            {fillCopy('exchangePageAboutBody', 'exchangePageAboutBodyEmpty')}
          </p>
        </div>
      </div>
    </>
  )
}
