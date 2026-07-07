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
  // Fallback category, used only when the content classifier finds no keyword match.
  category: CanonicalCategory
}

// ────────────────────────────────────────────────────────────────────────────
// Content-based category classifier (U7-3)
// Root cause: category was 100% hardcoded per RSS source, so every item from a
// given feed got the same category regardless of what the article was about
// (CryptoBriefing → everything "defi", generic feeds dumped funerals / 世界杯 /
// 台海 into "defi"). The classifier below routes on title+content keywords and
// OVERRIDES the source's hardcoded category. Output is restricted to the 5
// canonical categories the UI knows (see FlashNewsPageClient CATEGORY_DISPLAY_MAP):
// btc_eth | altcoin | defi | macro | exchange. We never emit a value the display
// map doesn't recognize (no 'nft').
// ────────────────────────────────────────────────────────────────────────────

type CanonicalCategory = 'btc_eth' | 'altcoin' | 'defi' | 'macro' | 'exchange'

// Keyword tables. Matched case-insensitively as substrings against `title + content`.
// zh keywords included because generic feeds surface Chinese-language items.
const CATEGORY_KEYWORDS: Record<CanonicalCategory, string[]> = {
  // Exchange-specific: named CEX/DEX + exchange actions (listing / reserves / delisting)
  exchange: [
    'binance',
    'okx',
    'coinbase',
    'bybit',
    'kraken',
    'kucoin',
    'bitget',
    'mexc',
    'gate.io',
    'gate io',
    'htx',
    'huobi',
    'upbit',
    'bitfinex',
    'crypto.com',
    'bitstamp',
    'bithumb',
    'gemini exchange',
    'listing',
    'will list',
    'lists ',
    'delisting',
    'delist',
    'proof of reserve',
    'proof-of-reserve',
    'reserves',
    '上币',
    '上线交易',
    '下架',
    '储备证明',
    '交易所',
  ],
  // Macro / regulation
  macro: [
    'fed',
    'federal reserve',
    'interest rate',
    'rate cut',
    'rate hike',
    'inflation',
    'cpi',
    'gdp',
    'recession',
    'regulation',
    'regulatory',
    'regulator',
    ' sec ',
    'sec ',
    'cftc',
    'lawsuit',
    'sues',
    'court',
    'congress',
    'senate',
    'treasury',
    'tariff',
    'policy',
    'central bank',
    'macro',
    '监管',
    '宏观',
    '美联储',
    '利率',
    '通胀',
    '政策',
    '法案',
  ],
  // DeFi
  defi: [
    'defi',
    'tvl',
    'lending',
    'dex ',
    'aave',
    'uniswap',
    'yield',
    'liquidity pool',
    'staking',
    'restaking',
    'eigenlayer',
    'curve finance',
    'compound',
    'makerdao',
    'lido',
    'pendle',
    'protocol',
    'stablecoin',
    'usdt',
    'usdc',
    'dai',
    '去中心化金融',
    '质押',
    '流动性',
  ],
  // BTC / ETH majors
  btc_eth: [
    'bitcoin',
    'btc',
    'ethereum',
    ' eth',
    'eth ',
    'ether',
    'satoshi',
    'halving',
    'vitalik',
    'spot etf',
    'etf',
    '比特币',
    '以太坊',
  ],
  // Named altcoins / memecoins
  altcoin: [
    'solana',
    ' sol ',
    'cardano',
    'ada ',
    'ripple',
    'xrp',
    'dogecoin',
    'doge',
    'shiba',
    'avalanche',
    'avax',
    'polkadot',
    'polygon',
    'matic',
    'chainlink',
    'link ',
    'litecoin',
    'tron',
    'ton ',
    'sui ',
    'aptos',
    'memecoin',
    'meme coin',
    'altcoin',
    'bnb',
    'pepe',
    'bonk',
    '山寨',
  ],
}

// Tie-break priority (most specific / salient first).
const CATEGORY_PRIORITY: CanonicalCategory[] = ['exchange', 'macro', 'defi', 'altcoin', 'btc_eth']

// Broad crypto vocabulary — presence of ANY term marks the item as crypto-related.
const CRYPTO_TERMS = [
  'crypto',
  'bitcoin',
  'btc',
  'ethereum',
  'eth',
  'blockchain',
  'token',
  'coin',
  'defi',
  'nft',
  'web3',
  'stablecoin',
  'altcoin',
  'wallet',
  'exchange',
  'mining',
  'miner',
  'satoshi',
  'onchain',
  'on-chain',
  'ledger',
  'dao',
  'airdrop',
  'staking',
  ...Object.values(CATEGORY_KEYWORDS).flat(),
  '加密',
  '币',
  '区块链',
  '链上',
  '钱包',
]

// Obvious off-topic markers from generic/aggregator feeds.
const NON_CRYPTO_MARKERS = [
  'funeral',
  'obituary',
  'world cup',
  'football',
  'soccer',
  'nba',
  'super bowl',
  'oscar',
  'grammy',
  'celebrity',
  'royal family',
  'election',
  'weather forecast',
  'hurricane',
  'earthquake',
  'wildfire',
  'recipe',
  'movie review',
  'box office',
  '葬礼',
  '世界杯',
  '台海',
  '选举',
  '足球',
  '奥斯卡',
]

function countMatches(haystack: string, keywords: string[]): number {
  let n = 0
  for (const kw of keywords) {
    if (haystack.includes(kw)) n++
  }
  return n
}

/** True if the item looks non-crypto and should be dropped (conservative). */
function isNonCrypto(title: string, content: string | null): boolean {
  const hay = `${title} ${content || ''}`.toLowerCase()
  const hasCrypto = CRYPTO_TERMS.some((t) => hay.includes(t))
  if (hasCrypto) return false
  // No crypto term AND hits an obvious off-topic marker → drop.
  return NON_CRYPTO_MARKERS.some((m) => hay.includes(m))
}

/**
 * Classify by title+content keywords. Returns a canonical category, or the
 * source's hardcoded fallback if nothing matches. Highest keyword-hit count
 * wins; ties broken by CATEGORY_PRIORITY.
 */
function classifyCategory(
  title: string,
  content: string | null,
  fallback: CanonicalCategory
): CanonicalCategory {
  const hay = `${title} ${content || ''}`.toLowerCase()
  let best: CanonicalCategory | null = null
  let bestScore = 0
  for (const cat of CATEGORY_PRIORITY) {
    const score = countMatches(hay, CATEGORY_KEYWORDS[cat])
    // strict > keeps priority order on ties (first in CATEGORY_PRIORITY wins)
    if (score > bestScore) {
      bestScore = score
      best = cat
    }
  }
  return bestScore > 0 && best ? best : fallback
}

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

async function fetchRSSFeed(feed: FeedConfig): Promise<
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
  try {
    const res = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    if (data.status !== 'ok' || !data.items) return []

    return (
      (data.items as RSSItem[])
        .slice(0, 5)
        .map((item) => {
          const title = (item.title || '').trim()
          const content =
            (item.description || '')
              .replace(/<[^>]*>/g, '')
              .trim()
              .slice(0, 500) || null
          return { item, title, content }
        })
        // Drop non-crypto items (funerals / 世界杯 / 台海 leaking from generic feeds).
        .filter(({ title, content }) => !isNonCrypto(title, content))
        .map(({ item, title, content }) => {
          const isBreaking = /breaking|urgent|alert/i.test(title)
          const isImportant = /SEC|Fed|ETF|hack|exploit|billion|crash|surge|soar/i.test(title)
          // Content classifier OVERRIDES the source's hardcoded category.
          const category = classifyCategory(title, content, feed.category)

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
            published_at: item.pubDate || new Date().toISOString(),
          }
        })
    )
  } catch (err) {
    logger.warn(`[flash-news-fetch] Failed to fetch ${feed.platform}:`, err)
    return []
  }
}

const handler = withCron('flash-news-fetch', async (_req: NextRequest) => {
  const supabase = getSupabaseAdmin()

  // Fetch all feeds in parallel
  const feedResults = await Promise.allSettled(RSS_FEEDS.map(fetchRSSFeed))
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

  if (allItems.length === 0) {
    return { count: 0, message: 'No items fetched' }
  }

  // Deduplicate by checking existing titles from last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: existing } = await supabase
    .from('flash_news')
    .select('title')
    .gte('published_at', since)

  const existingTitles = new Set((existing || []).map((e) => e.title.toLowerCase().trim()))
  const newItems = allItems.filter((item) => !existingTitles.has(item.title.toLowerCase().trim()))

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
