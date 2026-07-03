import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { EXCHANGE_CONFIG, resolveExchangeSlug } from '@/lib/constants/exchanges'
import { TOP_EXCHANGE_SLUGS } from '@/lib/constants/exchange-slugs'
import { BASE_URL } from '@/lib/constants/urls'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import PageHeader from '@/app/components/ui/PageHeader'
import { formatDisplayName } from '@/app/components/ranking/utils'
import {
  generateExchangeCollectionPageSchema,
  generateBreadcrumbSchema,
  type ExchangeSchemaInput,
} from '@/lib/seo/structured-data'

// ISR: regenerate exchange pages every 30 minutes
export const revalidate = 1800

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
  return createClient(url || '', key || '', {
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
  traderCount: number
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

async function fetchExchangeData(sourceKey: string): Promise<ExchangeData | null> {
  const config = EXCHANGE_CONFIG[sourceKey as keyof typeof EXCHANGE_CONFIG]
  if (!config) return null

  const supabase = getExchangeSupabase()

  const [topResult, countResult] = await Promise.all([
    supabase
      .from('leaderboard_ranks')
      .select('handle, source_trader_id, arena_score, roi, pnl, rank')
      .eq('source', sourceKey)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('arena_score', { ascending: false, nullsFirst: false })
      .limit(10),
    supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'estimated', head: true })
      .eq('source', sourceKey)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false'),
  ])

  const topTraders = (topResult.data || []).map((t, i) => {
    const sourceTraderId = (t.source_trader_id as string) || ''
    // Prefer the real handle; fall back to the wallet address (never a fabricated
    // "Trader N" that would link to a non-existent /trader/Trader%20N page).
    const linkTarget = (t.handle as string) || sourceTraderId
    return {
      displayName: linkTarget ? formatDisplayName(linkTarget, sourceKey) : `#${i + 1}`,
      linkTarget,
      sourceTraderId,
      arena_score: t.arena_score as number | null,
      roi: t.roi as number | null,
      pnl: t.pnl as number | null,
      rank: i + 1,
    }
  })

  return {
    displayName: config.name,
    sourceKey,
    sourceType: config.sourceType,
    traderCount: countResult.count ?? 0,
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

  if (!config) {
    notFound()
  }

  const displayName = config.name
  const data = await fetchExchangeData(sourceKey).catch(() => null)
  const traderCount = data?.traderCount ?? 0
  const topTrader = data?.topTraders?.[0]

  const title = `${displayName} Top Traders & Rankings | Arena`
  const description =
    traderCount > 0
      ? `Explore ${traderCount.toLocaleString()} ranked ${displayName} traders on Arena. ${topTrader ? `Top trader: ${topTrader.displayName}${topTrader.roi != null ? ` (${topTrader.roi >= 0 ? '+' : ''}${topTrader.roi.toFixed(1)}% ROI)` : ''}.` : ''} Compare Arena Scores, ROI, PnL, and risk metrics.`
      : `View ${displayName} crypto trader rankings on Arena. Compare performance, Arena Scores, ROI, and PnL across top traders.`

  const ogImageUrl = `${BASE_URL}/api/og/exchange?exchange=${encodeURIComponent(sourceKey)}`
  const canonicalUrl = `${BASE_URL}/exchange/${slug}`

  return {
    title,
    description,
    openGraph: {
      title,
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
      title,
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

  if (!config) {
    notFound()
  }

  const data = await fetchExchangeData(sourceKey)

  if (!data) {
    // Fallback: redirect to homepage with exchange filter if data fetch fails
    redirect(`/?ex=${encodeURIComponent(sourceKey)}`)
  }

  // JSON-LD structured data
  const schemaInput: ExchangeSchemaInput = {
    name: data.displayName,
    slug,
    sourceType: data.sourceType,
    traderCount: data.traderCount,
    topTraders: data.topTraders.map((t) => ({
      handle: t.displayName,
      arenaScore: t.arena_score,
      roi: t.roi,
    })),
  }
  const collectionPageJsonLd = generateExchangeCollectionPageSchema(schemaInput)
  const breadcrumbJsonLd = generateBreadcrumbSchema([
    { name: 'Arena', url: BASE_URL },
    { name: 'Rankings', url: `${BASE_URL}/` },
    { name: `${data.displayName} Rankings`, url: `${BASE_URL}/exchange/${slug}` },
  ])

  const sourceTypeLabel =
    data.sourceType === 'futures'
      ? 'Futures'
      : data.sourceType === 'spot'
        ? 'Spot'
        : 'DeFi / On-Chain'

  return (
    <>
      <JsonLd data={collectionPageJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 16px' }}>
        {/* Header */}
        <PageHeader
          title={`${data.displayName} Top Traders & Rankings`}
          subtitle={`${data.traderCount.toLocaleString()} ranked traders on ${data.displayName} (${sourceTypeLabel}). Updated every 30 minutes.`}
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
              Top 10 Traders by Arena Score
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
                      RANK
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
                      TRADER
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
                      ARENA SCORE
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
                      ROI (90D)
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
                      PNL
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
                          // eslint-disable-next-line no-restricted-syntax -- brand gold (matches purpleGold gradient) by design
                          color: '#D4AF37',
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
            View Full {data.displayName} Rankings
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
            About {data.displayName} Trader Rankings
          </h2>
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.7,
              color: 'var(--text-secondary, rgba(255,255,255,0.6))',
              margin: 0,
            }}
          >
            Arena tracks {data.traderCount.toLocaleString()} active traders on {data.displayName},
            ranking them by Arena Score — a composite metric combining ROI, PnL, risk management,
            and consistency across 7-day, 30-day, and 90-day periods. {data.displayName} is a{' '}
            {sourceTypeLabel.toLowerCase()} trading platform. All performance data is refreshed
            every 30 minutes from live exchange APIs.
          </p>
        </div>
      </div>
    </>
  )
}
