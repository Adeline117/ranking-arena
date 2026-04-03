/**
 * Farcaster Frame page for trader ranking cards
 * /frame/trader/[handle]?source=binance_futures&season=90D
 *
 * Serves fc:frame meta tags for Farcaster clients.
 */

import { Metadata } from 'next'
import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
})

export const revalidate = 300

import { BASE_URL } from '@/lib/constants/urls'

interface Props {
  params: Promise<{ handle: string }>
  searchParams: Promise<{ source?: string; season?: string }>
}

async function getTrader(handle: string, source?: string, season = '90D') {
  const params: string[] = [handle, season]
  let where = `(lr.handle ILIKE $1 OR lr.source_trader_id = $1) AND lr.season_id = $2`
  if (source) {
    params.push(source)
    where += ` AND lr.source = $3`
  }
  const { rows } = await pool.query(
    `SELECT lr.handle, lr.source, lr.source_trader_id, lr.arena_score, lr.rank, lr.roi
     FROM leaderboard_ranks lr
     WHERE ${where}
     ORDER BY lr.arena_score DESC NULLS LAST
     LIMIT 1`,
    params,
  )
  return rows[0] || null
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { handle } = await params
  const { source, season } = await searchParams
  const decodedHandle = decodeURIComponent(handle)

  const trader = await getTrader(decodedHandle, source, season || '90D')

  const name = trader?.handle || decodedHandle
  const score = trader?.arena_score ? parseFloat(trader.arena_score).toFixed(1) : '–'
  const rank = trader?.rank ? `${trader.rank}` : ''
  const roi = trader?.roi ? `${parseFloat(trader.roi) >= 0 ? '+' : ''}${parseFloat(trader.roi).toFixed(2)}%` : ''

  const title = `${name} Score ${score} ${rank}`
  const description = roi ? `${roi} ROI | Ranked on Arena` : `Trader ranking on Arena`

  // Build OG image URL
  const imgParams = new URLSearchParams({ handle: decodedHandle })
  if (source) imgParams.set('source', source)
  if (season) imgParams.set('season', season)
  const imageUrl = `${BASE_URL}/api/frame/trader?${imgParams}`

  // Profile URL on main site
  const profileSource = trader?.source || source || ''
  const profileId = trader?.source_trader_id || decodedHandle
  const profileUrl = `${BASE_URL}/trader/${encodeURIComponent(trader?.handle || decodedHandle)}${profileSource ? `?platform=${profileSource}` : ''}`

  // Frame URL (this page)
  const framePageParams = new URLSearchParams()
  if (source) framePageParams.set('source', source)
  if (season) framePageParams.set('season', season)
  const framePageUrl = `${BASE_URL}/frame/trader/${encodeURIComponent(decodedHandle)}${framePageParams.toString() ? '?' + framePageParams : ''}`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: imageUrl, width: 1200, height: 630 }],
    },
    other: {
      // Farcaster Frame v2 meta tags
      'fc:frame': 'vNext',
      'fc:frame:image': imageUrl,
      'fc:frame:image:aspect_ratio': '1.91:1',
      'fc:frame:button:1': `View ${name} on Arena`,
      'fc:frame:button:1:action': 'link',
      'fc:frame:button:1:target': profileUrl,
      'fc:frame:button:2': 'Share',
      'fc:frame:button:2:action': 'link',
      'fc:frame:button:2:target': framePageUrl,
      'fc:frame:post_url': `${BASE_URL}/api/frame/trader?${imgParams}`,
    },
  }
}

export default async function FrameTraderPage({ params, searchParams }: Props) {
  const { handle } = await params
  const { source, season } = await searchParams
  const decodedHandle = decodeURIComponent(handle)

  const imgParams = new URLSearchParams({ handle: decodedHandle })
  if (source) imgParams.set('source', source)
  if (season) imgParams.set('season', season)

  // Minimal page — the meta tags are what matter for Farcaster
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0B0A10',
        color: '#EDEDED',
        fontFamily: 'system-ui, sans-serif',
        padding: 40,
      }}
    >
      <img
        src={`/api/frame/trader?${imgParams}`}
        alt={`${decodedHandle} Arena Card`}
        style={{ maxWidth: 600, width: '100%', borderRadius: 16, marginBottom: 24 }}
      />
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>{decodedHandle}</h1>
      <p style={{ color: '#9A9A9A', margin: '8px 0 24px' }}>Trader Ranking Card on Arena</p>
      <a
        href={`${BASE_URL}/trader/${encodeURIComponent(decodedHandle)}${source ? `?platform=${source}` : ''}`}
        style={{
          background: '#8b6fa8',
          color: '#fff',
          padding: '12px 32px',
          borderRadius: 12,
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: 16,
        }}
      >
        View Full Profile →
      </a>
    </div>
  )
}
