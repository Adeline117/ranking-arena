/**
 * POST /api/cron/flash-news-fetch
 * Fetches crypto news from RSS feeds and inserts into flash_news table.
 * Runs every 30 minutes via Vercel cron.
 */
import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CRON_SECRET = env.CRON_SECRET

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

// Vercel Cron sends GET requests
export async function GET(req: NextRequest) {
  return handleFetch(req)
}

export async function POST(req: NextRequest) {
  return handleFetch(req)
}

async function handleFetch(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get('authorization')
  if (!CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const plog = await PipelineLogger.start('flash-news-fetch')

  try {
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
      await plog.success(0, { message: 'No items fetched' })
      return NextResponse.json({ inserted: 0, message: 'No items fetched' })
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
      await plog.success(0, { message: 'All items already exist' })
      return NextResponse.json({ inserted: 0, message: 'All items already exist' })
    }

    // Upsert new items — handle race conditions where duplicate titles slip through
    const { data: inserted, error: insertError } = await supabase
      .from('flash_news')
      .upsert(newItems, { onConflict: 'title', ignoreDuplicates: true })
      .select('id')

    if (insertError) {
      logger.error('[flash-news-fetch] Insert error:', insertError)
      await plog.error(new Error(insertError.message))
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    logger.info(`[flash-news-fetch] Inserted ${inserted?.length || 0} new flash news items`)
    await plog.success(inserted?.length || 0, { total_fetched: allItems.length })
    return NextResponse.json({ inserted: inserted?.length || 0, total_fetched: allItems.length })
  } catch (err) {
    logger.error('[flash-news-fetch] Error:', err)
    await plog.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
