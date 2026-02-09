/**
 * POST /api/cron/auto-news-post
 * Fetches crypto news from RSS feeds and auto-posts as official Arena account.
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

interface NewsItem {
  title: string
  content?: string
  source: string
  author?: string
  platform: string
  url?: string
  publishedAt: string
}

const RSS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', platform: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', platform: 'CoinTelegraph' },
  { url: 'https://bitcoinmagazine.com/.rss/full/', platform: 'Bitcoin Magazine' },
  { url: 'https://decrypt.co/feed', platform: 'Decrypt' },
  { url: 'https://www.theblock.co/rss.xml', platform: 'The Block' },
]

async function fetchRSS(feedUrl: string, platformName: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    if (data.status !== 'ok' || !data.items) return []
    return data.items.slice(0, 5).map((item: Record<string, unknown>) => ({
      title: (item.title as string || '').trim(),
      content: ((item.description as string) || '').replace(/<[^>]*>/g, '').trim().slice(0, 300),
      source: (item.author as string) || platformName,
      platform: platformName,
      author: (item.author as string) || undefined,
      url: item.link as string,
      publishedAt: (item.pubDate as string) || new Date().toISOString(),
    }))
  } catch {
    return []
  }
}

function formatPostContent(item: NewsItem): { title: string; content: string } {
  const title = item.title.length > 120 ? item.title.slice(0, 117) + '...' : item.title

  let content = `[${item.platform}]`
  if (item.author) content += ` @${item.author}`
  content += '\n\n'
  if (item.content && item.content.length > 10) {
    content += item.content + '\n\n'
  }
  if (item.url) {
    content += item.url
  }

  return { title, content: content.trim() }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // Get recent post titles to deduplicate
    const { data: lastPosts } = await supabase
      .from('posts')
      .select('title')
      .eq('author_id', OFFICIAL_USER_ID)
      .order('created_at', { ascending: false })
      .limit(50)

    const recentTitles = new Set((lastPosts || []).map((p: { title: string }) => p.title.toLowerCase().trim()))

    // Fetch all RSS feeds in parallel
    const results = await Promise.allSettled(
      RSS_FEEDS.map(f => fetchRSS(f.url, f.platform))
    )

    const allNews: NewsItem[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') allNews.push(...r.value)
    }

    // Deduplicate
    const seen = new Set<string>()
    const newItems: NewsItem[] = []
    for (const item of allNews) {
      if (!item.title) continue
      const key = item.title.toLowerCase().trim()
      if (seen.has(key.slice(0, 60))) continue
      if (recentTitles.has(key)) continue
      seen.add(key.slice(0, 60))
      newItems.push(item)
    }

    // Newest first, take 5
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
        errors.push(`${title.slice(0, 40)}: ${error.message}`)
      } else {
        posted++
      }
    }

    return NextResponse.json({
      ok: true,
      fetched: allNews.length,
      new: newItems.length,
      posted,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
