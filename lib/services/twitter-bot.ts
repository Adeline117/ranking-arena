/**
 * Twitter/X Bot Service
 *
 * Formats trader data into tweet-ready text and handles posting via Twitter API v2.
 * Environment variables: TWITTER_API_KEY, TWITTER_API_SECRET,
 * TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET
 */

import { logger } from '@/lib/logger'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { BASE_URL } from '@/lib/constants/urls'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopMover {
  handle: string | null
  source_trader_id: string
  source: string
  roi: number | null
  pnl: number | null
  arena_score: number | null
}

export interface TweetContent {
  text: string
  /** URL of the OG image to attach (if the Twitter API supports media upload) */
  ogImageUrl?: string
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Get display-friendly exchange name */
function exchangeName(source: string): string {
  return EXCHANGE_CONFIG[source as keyof typeof EXCHANGE_CONFIG]?.name ?? source
}

/** Format a trader name for tweet display */
function formatTraderName(mover: TopMover): string {
  if (mover.handle) return mover.handle
  // Truncate long wallet addresses
  const id = mover.source_trader_id
  if (id.length > 12) return `${id.slice(0, 6)}...${id.slice(-4)}`
  return id
}

/** Format ROI as a percentage string with sign */
function formatRoi(roi: number | null): string {
  if (roi == null) return 'N/A'
  const sign = roi >= 0 ? '+' : ''
  return `${sign}${roi.toFixed(1)}%`
}

/** Format PnL as abbreviated dollar amount */
function formatPnl(pnl: number | null): string {
  if (pnl == null) return ''
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

/**
 * Generate daily top movers tweet text.
 * Output fits within Twitter's 280-character limit per section.
 */
export function formatDailyTopMovers(movers: TopMover[], date: Date = new Date()): TweetContent {
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const lines = movers.slice(0, 5).map((m, i) => {
    const medal = ['1.', '2.', '3.', '4.', '5.'][i]
    const name = formatTraderName(m)
    const platform = exchangeName(m.source)
    const roi = formatRoi(m.roi)
    const pnl = m.pnl != null ? ` | ${formatPnl(m.pnl)}` : ''
    return `${medal} ${name} (${platform}) ${roi}${pnl}`
  })

  const text = [
    `Arena Daily Top 5 — ${dateStr}`,
    '',
    ...lines,
    '',
    `Ranked by Arena Score across 27+ exchanges`,
    `${BASE_URL}/rankings`,
  ].join('\n')

  const ogImageUrl = `${BASE_URL}/api/og/daily-top?date=${date.toISOString().split('T')[0]}`

  return { text, ogImageUrl }
}

/**
 * Generate a weekly recap tweet.
 */
export function formatWeeklyRecap(stats: {
  topTrader: TopMover | null
  totalTraders: number
  profitablePct: number
}): TweetContent {
  const { topTrader, totalTraders, profitablePct } = stats

  const topLine = topTrader
    ? `Top performer: ${formatTraderName(topTrader)} (${exchangeName(topTrader.source)}) — ${formatRoi(topTrader.roi)} ROI`
    : 'No top performer data this week'

  const text = [
    `Arena Weekly Recap`,
    '',
    topLine,
    `${profitablePct.toFixed(0)}% of ${totalTraders.toLocaleString()} tracked traders were profitable`,
    '',
    `Full rankings: ${BASE_URL}/rankings`,
  ].join('\n')

  return { text }
}

/**
 * Generate OG image URL for a specific exchange.
 */
export function getExchangeOgUrl(exchange: string): string {
  return `${BASE_URL}/api/og/exchange?exchange=${encodeURIComponent(exchange)}`
}

/**
 * Generate OG image URL for daily top movers.
 */
export function getDailyTopOgUrl(date: Date = new Date()): string {
  return `${BASE_URL}/api/og/daily-top?date=${date.toISOString().split('T')[0]}`
}

// ---------------------------------------------------------------------------
// Twitter API v2 Client
// ---------------------------------------------------------------------------

interface TwitterCredentials {
  apiKey: string
  apiSecret: string
  accessToken: string
  accessTokenSecret: string
}

function getCredentials(): TwitterCredentials | null {
  const apiKey = process.env.TWITTER_API_KEY
  const apiSecret = process.env.TWITTER_API_SECRET
  const accessToken = process.env.TWITTER_ACCESS_TOKEN
  const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    return null
  }

  return { apiKey, apiSecret, accessToken, accessTokenSecret }
}

/**
 * Post a tweet using Twitter API v2 (OAuth 1.0a).
 *
 * Returns the tweet ID on success, or null if credentials are missing
 * or the post fails.
 *
 * NOTE: Actual OAuth 1.0a signing is non-trivial (HMAC-SHA1 signatures).
 * For production, install `twitter-api-v2` package:
 *   npm install twitter-api-v2
 * Then replace the fetch call below with:
 *   const client = new TwitterApi({ appKey, appSecret, accessToken, accessSecret })
 *   const { data } = await client.v2.tweet(text)
 *
 * For now, this logs the content and returns null (dry-run mode).
 */
export async function postTweet(content: TweetContent): Promise<string | null> {
  const creds = getCredentials()

  if (!creds) {
    logger.info('[twitter-bot] No Twitter API credentials configured — logging tweet content (dry-run)')
    logger.info(`[twitter-bot] Tweet (${content.text.length} chars):\n${content.text}`)
    if (content.ogImageUrl) {
      logger.info(`[twitter-bot] OG image: ${content.ogImageUrl}`)
    }
    return null
  }

  // TODO: Implement actual Twitter API v2 posting with OAuth 1.0a
  // When twitter-api-v2 package is installed:
  //
  // import { TwitterApi } from 'twitter-api-v2'
  // const client = new TwitterApi({
  //   appKey: creds.apiKey,
  //   appSecret: creds.apiSecret,
  //   accessToken: creds.accessToken,
  //   accessSecret: creds.accessTokenSecret,
  // })
  // const { data } = await client.v2.tweet(content.text)
  // return data.id

  logger.info(`[twitter-bot] Would post tweet (${content.text.length} chars):\n${content.text}`)
  return null
}
