/**
 * POST /api/cron/flash-news-fetch
 * Fetches crypto news from RSS feeds and inserts into flash_news table.
 * Runs every 30 minutes via Vercel cron.
 */
import { NextRequest } from 'next/server'
import logger from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'
import { classifyCategory, isNonCrypto, type CanonicalCategory } from '@/lib/flash-news/classify'
import { translateText, type TranslateTarget } from '@/lib/services/translate-server'

export const dynamic = 'force-dynamic'
// Each new item fans out to 3 free gtx calls (zh/ja/ko). The run-wide abort,
// per-call timeout, and item cap keep feed + translation + persistence inside
// this platform limit.
export const maxDuration = 60

const WORK_TIMEOUT_MS = 45_000
const FEED_TIMEOUT_MS = 8_000
const TRANSLATE_TIMEOUT_MS = 4_000
const MAX_ITEMS_PER_RUN = 24

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
  // Fallback category, used only when the content classifier finds no keyword match.
  category: CanonicalCategory
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRSSItem(value: unknown): value is RSSItem {
  if (!isRecord(value) || typeof value.title !== 'string') return false
  return ['description', 'link', 'author', 'pubDate'].every(
    (key) => value[key] === undefined || typeof value[key] === 'string'
  )
}

// Content-based category classifier (U7-3) + non-crypto filter now live in
// lib/flash-news/classify.ts so the cron + backfill script share one source of
// truth. classifyCategory OVERRIDES the source's hardcoded category; output is
// restricted to the 5 canonical categories the UI knows.

const RSS_FEEDS: FeedConfig[] = [
  {
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    platform: 'CoinDesk',
    category: 'btc_eth',
  },
  { url: 'https://cointelegraph.com/rss', platform: 'CoinTelegraph', category: 'btc_eth' },
  {
    url: 'https://bitcoinmagazine.com/.rss/full/',
    platform: 'Bitcoin Magazine',
    category: 'btc_eth',
  },
  { url: 'https://decrypt.co/feed', platform: 'Decrypt', category: 'altcoin' },
  { url: 'https://www.theblock.co/rss.xml', platform: 'The Block', category: 'macro' },
  { url: 'https://defillama.com/rss', platform: 'DefiLlama', category: 'defi' },
  { url: 'https://beincrypto.com/feed/', platform: 'BeInCrypto', category: 'altcoin' },
  { url: 'https://cryptobriefing.com/feed/', platform: 'CryptoBriefing', category: 'defi' },
  { url: 'https://cryptoslate.com/feed/', platform: 'CryptoSlate', category: 'macro' },
  { url: 'https://www.dlnews.com/arc/outboundfeeds/rss/', platform: 'DL News', category: 'defi' },
]

async function fetchRSSFeed(
  feed: FeedConfig,
  signal: AbortSignal
): Promise<
  {
    title: string
    content: string | null
    source: string
    source_url: string | null
    category: string
    importance: 'normal' | 'important' | 'breaking'
    published_at: string
  }[]
> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(FEED_TIMEOUT_MS)])
  const response = await fetch(
    `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`,
    { signal: requestSignal }
  )
  if (!response.ok) {
    throw new Error(`${feed.platform} RSS gateway returned HTTP ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (!isRecord(payload) || payload.status !== 'ok' || !Array.isArray(payload.items)) {
    throw new Error(`${feed.platform} RSS gateway returned an invalid payload`)
  }

  const validItems = payload.items.filter(isRSSItem)
  if (payload.items.length > 0 && validItems.length === 0) {
    throw new Error(`${feed.platform} RSS gateway returned invalid items`)
  }

  return validItems
    .slice(0, 5)
    .map((item) => {
      const title = item.title.trim()
      const content =
        (item.description || '')
          .replace(/<[^>]*>/g, '')
          .trim()
          .slice(0, 500) || null
      return { item, title, content }
    })
    .filter(({ title, content }) => title.length > 0 && !isNonCrypto(title, content))
    .map(({ item, title, content }) => {
      const isBreaking = /breaking|urgent|alert/i.test(title)
      const isImportant = /SEC|Fed|ETF|hack|exploit|billion|crash|surge|soar/i.test(title)
      const category = classifyCategory(title, content, feed.category)
      const publishedAt = item.pubDate ? Date.parse(item.pubDate) : Number.NaN

      return {
        title,
        content,
        source: feed.platform,
        source_url: item.link || null,
        category,
        importance: isBreaking
          ? ('breaking' as const)
          : isImportant
            ? ('important' as const)
            : ('normal' as const),
        published_at: Number.isFinite(publishedAt)
          ? new Date(publishedAt).toISOString()
          : new Date().toISOString(),
      }
    })
}

// Ingest-time multilingual titles (U7-5). Titles arrive in English, so we set
// title_en = original and pre-translate into zh/ja/ko via the free gtx endpoint.
// Best-effort: a failed/timed-out translation leaves that column null and the
// frontend falls back to title_en. gtx has rate limits, so we translate in small
// concurrent batches with a short delay between batches.
const TITLE_TRANSLATE_TARGETS: TranslateTarget[] = ['zh', 'ja', 'ko']

type TranslatedTitles = {
  title_en: string
  title_zh: string | null
  title_ja: string | null
  title_ko: string | null
}

async function withTranslatedTitles<T extends { title: string }>(
  items: T[],
  signal: AbortSignal
): Promise<(T & TranslatedTitles)[]> {
  const CONCURRENCY = 3
  const enriched: (T & TranslatedTitles)[] = []
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    signal.throwIfAborted()
    const batch = items.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (item) => {
        const [zh, ja, ko] = await Promise.all(
          TITLE_TRANSLATE_TARGETS.map((tl) =>
            translateText(item.title, tl, 'en', TRANSLATE_TIMEOUT_MS, signal)
          )
        )
        return {
          ...item,
          title_en: item.title, // English original
          title_zh: zh,
          title_ja: ja,
          title_ko: ko,
        }
      })
    )
    signal.throwIfAborted()
    enriched.push(...results)
    if (i + CONCURRENCY < items.length) await new Promise((r) => setTimeout(r, 150))
  }
  return enriched
}

const runFlashNewsFetch: Parameters<typeof withCron>[1] = async (_req, { supabase }) => {
  const workSignal = AbortSignal.timeout(WORK_TIMEOUT_MS)

  // Fetch all feeds in parallel
  const feedResults = await Promise.allSettled(
    RSS_FEEDS.map((feed) => fetchRSSFeed(feed, workSignal))
  )
  const rejectedFeeds = feedResults.filter((r) => r.status === 'rejected')
  if (rejectedFeeds.length > 0) {
    logger.warn(
      `[flash-news-fetch] ${rejectedFeeds.length}/${feedResults.length} feeds failed: ${rejectedFeeds.map((r) => (r as PromiseRejectedResult).reason?.message || String((r as PromiseRejectedResult).reason)).join('; ')}`
    )
  }
  const allItems = feedResults
    .filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchRSSFeed>>> =>
        r.status === 'fulfilled'
    )
    .flatMap((r) => r.value)

  if (rejectedFeeds.length === feedResults.length) {
    throw new Error('All flash-news RSS feeds failed')
  }

  if (allItems.length === 0) {
    return { count: 0, message: 'No items fetched', feed_failures: rejectedFeeds.length }
  }

  // Deduplicate by checking existing titles from last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: existing, error: existingError } = await supabase
    .from('flash_news')
    .select('title')
    .gte('published_at', since)
    .abortSignal(workSignal)

  if (existingError || !Array.isArray(existing)) {
    throw new Error(
      `Flash-news deduplication query failed: ${existingError?.message ?? 'invalid payload'}`
    )
  }
  if (existing.some((item) => typeof item.title !== 'string')) {
    throw new Error('Flash-news deduplication query returned an invalid title')
  }

  const seenTitles = new Set(existing.map((item) => item.title.toLowerCase().trim()))
  const newItems = allItems.filter((item) => {
    const title = item.title.toLowerCase().trim()
    if (seenTitles.has(title)) return false
    seenTitles.add(title)
    return true
  })

  if (newItems.length === 0) {
    return { count: 0, message: 'All items already exist' }
  }

  // Pre-translate titles (en → zh/ja/ko) before insert. Best-effort — never
  // blocks the insert; a failed translation just leaves that column null.
  const itemsForThisRun = newItems.slice(0, MAX_ITEMS_PER_RUN)
  const itemsToInsert = await withTranslatedTitles(itemsForThisRun, workSignal)

  // Upsert new items
  const { data: inserted, error: insertError } = await supabase
    .from('flash_news')
    .upsert(itemsToInsert, { onConflict: 'title', ignoreDuplicates: true })
    .select('id')
    .abortSignal(workSignal)

  if (insertError || !Array.isArray(inserted)) {
    logger.error('[flash-news-fetch] Insert error:', insertError)
    throw new Error(`Flash-news insert failed: ${insertError?.message ?? 'invalid payload'}`)
  }

  logger.info(`[flash-news-fetch] Inserted ${inserted.length} new flash news items`)
  return {
    count: inserted.length,
    total_fetched: allItems.length,
    feed_failures: rejectedFeeds.length,
    deferred: newItems.length - itemsForThisRun.length,
  }
}

const handler = withCron('flash-news-fetch', runFlashNewsFetch, { safetyTimeoutMs: 55_000 })

// Vercel Cron sends GET requests
export const GET = handler
export async function POST(req: NextRequest) {
  return handler(req)
}
