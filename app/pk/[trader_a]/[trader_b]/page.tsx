/**
 * Trader PK Comparison Page
 * Route: /pk/[trader_a]/[trader_b]?platform=xxx&window=7d
 *
 * SSR server component — fetches both traders' data, renders a fighting-game
 * style comparison UI with metric-by-metric winner highlighting.
 * OG meta tags are injected server-side so X/Twitter can preview the card.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'

import { fetchPKTrader } from './pk-data'
import { buildMetrics, computeOverallWinner } from './pk-metrics'
import {
  COLOR,
  FighterCard,
  VSDivider,
  MetricsTable,
  WinnerBanner,
} from './pk-ui'
import PKPageClient from './PKPageClient'

const BASE_URL = 'https://www.arenafi.org'

// ─── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ trader_a: string; trader_b: string }>
  searchParams: Promise<{ platform?: string; window?: string }>
}): Promise<Metadata> {
  const { trader_a, trader_b } = await params
  const sp = await searchParams
  const platform = sp.platform || ''
  const timeWindow = sp.window || '90d'

  const handleA = decodeURIComponent(trader_a)
  const handleB = decodeURIComponent(trader_b)

  const pageUrl = `${BASE_URL}/pk/${encodeURIComponent(handleA)}/${encodeURIComponent(handleB)}${
    platform ? `?platform=${encodeURIComponent(platform)}` : ''
  }`
  const ogImageUrl = `${BASE_URL}/api/og/pk?a=${encodeURIComponent(handleA)}&b=${encodeURIComponent(handleB)}${
    platform ? `&platform=${encodeURIComponent(platform)}` : ''
  }&window=${encodeURIComponent(timeWindow)}`

  const title = `${handleA} vs ${handleB} | Arena PK`
  const description = `Trader PK: ${handleA} challenges ${handleB} on Arena. See who wins across ROI, Win Rate, Arena Score and more.`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: pageUrl,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${handleA} vs ${handleB} Arena PK`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImageUrl],
    },
    alternates: { canonical: pageUrl },
  }
}

// ─── Page params ──────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic'

// ─── Page component ───────────────────────────────────────────────────────────

export default async function PKPage({
  params,
  searchParams,
}: {
  params: Promise<{ trader_a: string; trader_b: string }>
  searchParams: Promise<{ platform?: string; window?: string }>
}) {
  const { trader_a, trader_b } = await params
  const sp = await searchParams
  const platform = sp.platform || ''
  const timeWindow = (sp.window || '90d').toLowerCase()

  const handleA = decodeURIComponent(trader_a)
  const handleB = decodeURIComponent(trader_b)

  // Fetch both traders in parallel
  const [dataA, dataB] = await Promise.all([
    fetchPKTrader(handleA, platform || null, timeWindow),
    fetchPKTrader(handleB, platform || null, timeWindow),
  ])

  if (!dataA && !dataB) {
    notFound()
  }

  const nameA = dataA?.display_name || handleA
  const nameB = dataB?.display_name || handleB

  const metrics = dataA && dataB ? buildMetrics(dataA, dataB) : []
  const overall =
    dataA && dataB ? computeOverallWinner(metrics, nameA, nameB) : null

  const windowLabel =
    timeWindow === '7d' ? '7D' : timeWindow === '30d' ? '30D' : '90D'

  const pkUrl = `${BASE_URL}/pk/${encodeURIComponent(handleA)}/${encodeURIComponent(handleB)}${
    platform ? `?platform=${encodeURIComponent(platform)}` : ''
  }`

  return (
    <div
      style={{
        minHeight: '100vh',
        background: `linear-gradient(160deg, ${COLOR.bg} 0%, #130f1e 40%, #0f0d19 70%, ${COLOR.bg} 100%)`,
        color: COLOR.text,
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      {/* Top gradient accent bar */}
      <div
        style={{
          height: 3,
          background:
            'linear-gradient(90deg, #8b6fa8 0%, #FFD700 50%, #8b6fa8 100%)',
        }}
      />

      <div
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '32px 20px 64px',
        }}
      >
        {/* Breadcrumb nav */}
        <nav
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 32,
            fontSize: 13,
            color: COLOR.sub,
          }}
        >
          <Link
            href="/"
            style={{ color: COLOR.sub, textDecoration: 'none' }}
          >
            Arena
          </Link>
          <span>/</span>
          <Link
            href={`/trader/${encodeURIComponent(handleA)}`}
            style={{ color: COLOR.sub, textDecoration: 'none' }}
          >
            {nameA}
          </Link>
          <span>/</span>
          <span style={{ color: COLOR.brand }}>PK</span>
        </nav>

        {/* Page title */}
        <div
          style={{
            textAlign: 'center',
            marginBottom: 40,
          }}
        >
          <div
            style={{
              fontSize: 12,
              letterSpacing: 5,
              color: COLOR.sub,
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            ARENA PK — {windowLabel} BATTLE
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 36,
              fontWeight: 900,
              background:
                'linear-gradient(90deg, #8b6fa8 0%, #FFD700 50%, #8b6fa8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: -1,
            }}
          >
            TRADER SHOWDOWN
          </h1>
        </div>

        {/* Fighter cards row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            gap: 0,
            alignItems: 'center',
            marginBottom: 40,
          }}
        >
          <FighterCard
            data={dataA}
            displayName={nameA}
            handle={handleA}
            side="a"
          />
          <VSDivider />
          <FighterCard
            data={dataB}
            displayName={nameB}
            handle={handleB}
            side="b"
          />
        </div>

        {/* Metrics comparison table */}
        {metrics.length > 0 && (
          <MetricsTable metrics={metrics} nameA={nameA} nameB={nameB} />
        )}

        {/* Overall winner banner */}
        {overall && (
          <WinnerBanner overall={overall} nameA={nameA} nameB={nameB} />
        )}

        {/* Action buttons */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <PKPageClient
            handleA={handleA}
            handleB={handleB}
            platform={platform}
            window={timeWindow}
            nameA={nameA}
            nameB={nameB}
            pkUrl={pkUrl}
          />
        </div>

        {/* Footer note */}
        <div
          style={{
            textAlign: 'center',
            marginTop: 48,
            fontSize: 12,
            color: 'rgba(255,255,255,0.2)',
          }}
        >
          arena.arenafi.org — Transparent Crypto Trader Rankings
        </div>
      </div>
    </div>
  )
}
