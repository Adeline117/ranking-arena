/**
 * POST /api/cron/auto-news-post
 * Fetches crypto news from multiple sources and auto-posts as official Arena account.
 * Runs every 30 minutes.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET = process.env.CRON_SECRET

const OFFICIAL_USER_ID = '657ef0ce-c8cd-4ded-bda7-cf60259b7256'
const NEWS_GROUP_ID = 'a1b2c3d4-0001-4000-8000-000000000001'

// Platform icons (text-based, no emoji)
const PLATFORM_TAGS: Record<string, string> = {
  twitter: 'X/Twitter',
  x: 'X/Twitter',
  reddit: 'Reddit',
  coindesk: 'CoinDesk',
  cointelegraph: 'CoinTelegraph',
  theblock: 'The Block',
  decrypt: 'Decrypt',
  bitcoinmagazine: 'Bitcoin Magazine',
  bloomberg: 'Bloomberg',
  reuters: 'Reuters',
  binance: 'Binance',
  coingecko: 'CoinGecko',
  defillama: 'DefiLlama',
  cryptopanic: 'CryptoPanic',
  rss3: 'RSS3',
}

interface NewsItem {
  title: string
  content?: string
  source: string
  author?: string
  platform: string
  url?: string
  publishedAt: string
}

// Fetch from CryptoPanic (free, no key required for public feed)
async function fetchCryptoPanic(): Promise<NewsItem[]> {
  try {
    const res = await fetch('https://cryptopanic.com/api/free/v1/posts/?auth_token=free&public=true&kind=news', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    if (!data.results) return []
    return data.results.slice(0, 10).map((item: Record<string, unknown>) => {
      const source = (item.source as Record<string, string>)
      return {
        title: item.title as string,
        source: source?.title || 'Unknown',
        platform: source?.domain || 'crypto',
        author: undefined,
        url: item.url as string,
        publishedAt: item.published_at as string,
      }
    })
  } catch {
    return []
  }
}

// Fetch from CoinGecko news (free)
async function fetchCoinGeckoNews(): Promise<NewsItem[]> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/news', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    if (!data.data) return []
    return data.data.slice(0, 8).map((item: Record<string, unknown>) => ({
      title: item.title as string,
      content: (item.description as string)?.slice(0, 200),
      source: (item.author as string) || 'CoinGecko News',
      platform: 'coingecko',
      author: item.author as string,
      url: item.url as string,
      publishedAt: item.updated_at as string || new Date().toISOString(),
    }))
  } catch {
    return []
  }
}

// Fetch from RSS feeds via rss2json
async function fetchRSS(feedUrl: string, platformName: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    if (data.status !== 'ok' || !data.items) return []
    return data.items.slice(0, 5).map((item: Record<string, unknown>) => ({
      title: item.title as string,
      content: (item.description as string)?.replace(/<[^>]*>/g, '').slice(0, 200),
      source: (item.author as string) || platformName,
      platform: platformName.toLowerCase().replace(/\s/g, ''),
      author: item.author as string,
      url: item.link as string,
      publishedAt: item.pubDate as string || new Date().toISOString(),
    }))
  } catch {
    return []
  }
}

function formatPostContent(item: NewsItem): { title: string; content: string } {
  const platformLabel = PLATFORM_TAGS[item.platform.toLowerCase()] || item.platform
  const authorStr = item.author ? `@${item.author}` : ''
  const sourceTag = `[${platformLabel}]`
  
  const title = item.title.length > 100 ? item.title.slice(0, 97) + '...' : item.title
  
  let content = ''
  content += `${sourceTag}`
  if (authorStr) content += ` ${authorStr}`
  content += '\n\n'
  if (item.content) {
    content += item.content + '\n\n'
  }
  if (item.url) {
    content += item.url
  }
  
  return { title, content: content.trim() }
}

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get('authorization')
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Get last post time to avoid duplicates
  const { data: lastPost } = await supabase
    .from('posts')
    .select('created_at, title')
    .eq('author_id', OFFICIAL_USER_ID)
    .order('created_at', { ascending: false })
    .limit(20)

  const recentTitles = new Set((lastPost || []).map(p => p.title.toLowerCase().trim()))

  // Fetch from all sources in parallel
  const [cryptoPanic, coinGecko, coinDesk, coinTelegraph, bitcoinMag] = await Promise.all([
    fetchCryptoPanic(),
    fetchCoinGeckoNews(),
    fetchRSS('https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk'),
    fetchRSS('https://cointelegraph.com/rss', 'CoinTelegraph'),
    fetchRSS('https://bitcoinmagazine.com/.rss/full/', 'Bitcoin Magazine'),
  ])

  const allNews = [...cryptoPanic, ...coinGecko, ...coinDesk, ...coinTelegraph, ...bitcoinMag]

  // Deduplicate by title similarity and filter already-posted
  const seen = new Set<string>()
  const newItems: NewsItem[] = []

  for (const item of allNews) {
    if (!item.title) continue
    const titleKey = item.title.toLowerCase().trim().slice(0, 60)
    if (seen.has(titleKey)) continue
    if (recentTitles.has(item.title.toLowerCase().trim())) continue
    seen.add(titleKey)
    newItems.push(item)
  }

  // Sort by time (newest first), take top 5
  newItems.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
  const toPost = newItems.slice(0, 5)

  let posted = 0
  const errors: string[] = []

  for (const item of toPost) {
    const { title, content } = formatPostContent(item)
    
    const { error } = await supabase.from('posts').insert({
      author_id: OFFICIAL_USER_ID,
      author_handle: 'Arena',
      group_id: NEWS_GROUP_ID,
      title,
      content,
      status: 'active',
    })

    if (error) {
      errors.push(`${title}: ${error.message}`)
    } else {
      posted++
    }
  }

  // Update group member count
  await supabase.rpc('exec_sql', {
    query: `UPDATE groups SET member_count = (SELECT COUNT(*) FROM group_members WHERE group_id = '${NEWS_GROUP_ID}') WHERE id = '${NEWS_GROUP_ID}'`,
  }).catch(() => {})

  return NextResponse.json({
    ok: true,
    fetched: allNews.length,
    new: newItems.length,
    posted,
    errors: errors.length > 0 ? errors : undefined,
  })
}
