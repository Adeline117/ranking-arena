/**
 * POST /api/cron/flash-news-fetch
 * Fetches crypto news from RSS feeds and inserts into flash_news table.
 * Runs every 30 minutes via Vercel cron.
 */
import { NextRequest } from 'next/server'
import logger from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { withCron } from '@/lib/api/with-cron'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

interface RSSItem {
  title: string
  description?: string
  link?: string
  author?: string
  pubDate?: string
}

interface FeedConfig {
  url: string
  platform: string
  category: 'btc_eth' | 'altcoin' | 'defi' | 'macro' | 'exchange' | 'crypto' | 'market'
}

const RSS_FEEDS: FeedConfig[] = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', platform: 'CoinDesk', category: 'btc_eth' },
  { url: 'https://cointelegraph.com/rss', platform: 'CoinTelegraph', category: 'btc_eth' },
  { url: 'https://bitcoinmagazine.com/.rss/full/', platform: 'Bitcoin Magazine', category: 'btc_eth' },
  { url: 'https://decrypt.co/feed', platform: 'Decrypt', category: 'altcoin' },
  { url: 'https://www.theblock.co/rss.xml', platform: 'The Block', category: 'macro' },
  { url: 'https://defillama.com/rss', platform: 'DefiLlama', category: 'defi' },
  { url: 'https://beincrypto.com/feed/', platform: 'BeInCrypto', category: 'altcoin' },
  { url: 'https://cryptobriefing.com/feed/', platform: 'CryptoBriefing', category: 'defi' },
  { url: 'https://cryptoslate.com/feed/', platform: 'CryptoSlate', category: 'macro' },
  { url: 'https://www.dlnews.com/arc/outboundfeeds/rss/', platform: 'DL News', category: 'defi' },
]

async function fetchRSSFeed(feed: FeedConfig): Promise<{
  title: string
  content: string | null
  source: string
  source_url: string | null
  category: string
  importance: 'normal' | 'important' | 'breaking'
  published_at: string
}[]> {
  try {
    const res = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    if (data.status !== 'ok' || !data.items) return []

    return (data.items as RSSItem[]).slice(0, 5).map((item) => {
      const title = (item.title || '').trim()
      const content = ((item.description || '').replace(/<[^>]*>/g, '').trim()).slice(0, 500) || null
      const isBreaking = /breaking|urgent|alert/i.test(title)
      const isImportant = /SEC|Fed|ETF|hack|exploit|billion|crash|surge|soar/i.test(title)

      return {
        title,
        content,
        source: feed.platform,
        source_url: item.link || null,
        category: feed.category,
        importance: isBreaking ? 'breaking' as const : isImportant ? 'important' as const : 'normal' as const,
        published_at: item.pubDate || new Date().toISOString(),
      }
    })
  } catch (err) {
    logger.warn(`[flash-news-fetch] Failed to fetch ${feed.platform}:`, err)
    return []
  }
}

const handler = withCron('flash-news-fetch', async (_req: NextRequest) => {
  const supabase = getSupabaseAdmin()

  // Fetch all feeds in parallel
  const feedResults = await Promise.allSettled(RSS_FEEDS.map(fetchRSSFeed))
  const rejectedFeeds = feedResults.filter(r => r.status === 'rejected')
  if (rejectedFeeds.length > 0) {
    logger.warn(`[flash-news-fetch] ${rejectedFeeds.length}/${feedResults.length} feeds failed: ${rejectedFeeds.map(r => (r as PromiseRejectedResult).reason?.message || String((r as PromiseRejectedResult).reason)).join('; ')}`)
  }
  const allItems = feedResults
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchRSSFeed>>> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  if (allItems.length === 0) {
    return { count: 0, message: 'No items fetched' }
  }

  // Deduplicate by checking existing titles from last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: existing } = await supabase
    .from('flash_news')
    .select('title')
    .gte('published_at', since)

  const existingTitles = new Set((existing || []).map(e => e.title.toLowerCase().trim()))
  const newItems = allItems.filter(item => !existingTitles.has(item.title.toLowerCase().trim()))

  if (newItems.length === 0) {
    return { count: 0, message: 'All items already exist' }
  }

  // Upsert new items
  const { data: inserted, error: insertError } = await supabase
    .from('flash_news')
    .upsert(newItems, { onConflict: 'title', ignoreDuplicates: true })
    .select('id')

  if (insertError) {
    logger.error('[flash-news-fetch] Insert error:', insertError)
    throw new Error(insertError.message)
  }

  logger.info(`[flash-news-fetch] Inserted ${inserted?.length || 0} new flash news items`)
  return { count: inserted?.length || 0, total_fetched: allItems.length }
})

// Vercel Cron sends GET requests
export const GET = handler
export async function POST(req: NextRequest) {
  return handler(req)
}
