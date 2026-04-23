/**
 * Sitemap API Route — serves sitemap index + shard XML
 *
 * Why not app/sitemap.ts? Next.js metadata sitemap routes pre-render at
 * build time and cache the result. At build time, Supabase env vars are
 * placeholders, so all DB queries fail and sitemaps come back empty.
 * Neither force-dynamic nor revalidate fixed this reliably.
 *
 * This API route runs at request time with real env vars, guaranteed.
 *
 * Routes:
 *   GET /api/sitemap           → sitemap index XML
 *   GET /api/sitemap?shard=0   → static pages
 *   GET /api/sitemap?shard=1-N → trader pages (5000 per shard)
 *   GET /api/sitemap?shard=999 → posts, groups, user profiles
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BASE_URL = 'https://www.arenafi.org'
const TRADERS_PER_SHARD = 5000

function xmlResponse(xml: string): NextResponse {
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function GET(request: NextRequest) {
  const shard = request.nextUrl.searchParams.get('shard')

  // No shard param → return sitemap index
  if (shard === null) {
    const traderCount = await getTraderCount()
    const shardCount = Math.ceil(traderCount / TRADERS_PER_SHARD) || 1
    const shards = [0, ...Array.from({ length: shardCount }, (_, i) => i + 1), 999]
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${shards.map((id) => `  <sitemap><loc>${BASE_URL}/api/sitemap?shard=${id}</loc></sitemap>`).join('\n')}
</sitemapindex>`
    return xmlResponse(xml)
  }

  const shardId = Number(shard)
  const now = new Date().toISOString()

  // Shard 0: static pages (no DB)
  if (shardId === 0) {
    const urls = [
      { url: '/', priority: 1, freq: 'hourly' },
      { url: '/hot', priority: 0.9, freq: 'hourly' },
      { url: '/market', priority: 0.8, freq: 'hourly' },
      { url: '/groups', priority: 0.8, freq: 'daily' },
      { url: '/rankings/bots', priority: 0.8, freq: 'daily' },
      { url: '/rankings/tokens', priority: 0.8, freq: 'daily' },
      { url: '/pricing', priority: 0.7, freq: 'monthly' },
      { url: '/methodology', priority: 0.7, freq: 'monthly' },
      { url: '/learn', priority: 0.75, freq: 'weekly' },
      { url: '/search', priority: 0.6, freq: 'weekly' },
      { url: '/flash-news', priority: 0.7, freq: 'hourly' },
      { url: '/feed', priority: 0.7, freq: 'hourly' },
      { url: '/compare', priority: 0.6, freq: 'weekly' },
      { url: '/competitions', priority: 0.7, freq: 'daily' },
      { url: '/claim', priority: 0.6, freq: 'monthly' },
      { url: '/about', priority: 0.4, freq: 'monthly' },
      { url: '/help', priority: 0.5, freq: 'monthly' },
      { url: '/privacy', priority: 0.2, freq: 'yearly' },
      { url: '/terms', priority: 0.2, freq: 'yearly' },
      { url: '/disclaimer', priority: 0.2, freq: 'yearly' },
    ]
    return xmlResponse(
      urlsetXml(
        urls.map((u) => ({
          loc: `${BASE_URL}${u.url}`,
          lastmod: now,
          changefreq: u.freq,
          priority: u.priority,
        }))
      )
    )
  }

  // Shard 999: posts, groups, user profiles
  if (shardId === 999) {
    const supabase = getSupabase()
    const [posts, groups, users] = await Promise.all([
      supabase
        .from('posts')
        .select('id, updated_at')
        .order('hot_score', { ascending: false })
        .limit(500),
      supabase
        .from('groups')
        .select('id, created_at')
        .order('member_count', { ascending: false })
        .limit(500),
      supabase
        .from('user_profiles')
        .select('handle, updated_at')
        .not('handle', 'is', null)
        .limit(5000),
    ])
    const entries = [
      ...(posts.data || []).map((p) => ({
        loc: `${BASE_URL}/post/${p.id}`,
        lastmod: p.updated_at,
        changefreq: 'weekly',
        priority: 0.6,
      })),
      ...(groups.data || []).map((g) => ({
        loc: `${BASE_URL}/groups/${g.id}`,
        lastmod: g.created_at,
        changefreq: 'daily',
        priority: 0.7,
      })),
      ...(users.data || [])
        .filter((u) => u.handle)
        .map((u) => ({
          loc: `${BASE_URL}/u/${encodeURIComponent(u.handle)}`,
          lastmod: u.updated_at,
          changefreq: 'weekly',
          priority: 0.5,
        })),
    ]
    return xmlResponse(urlsetXml(entries))
  }

  // Shard 1..N: trader pages
  const supabase = getSupabase()
  const offset = (shardId - 1) * TRADERS_PER_SHARD
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('handle, source_trader_id, computed_at')
    .eq('season_id', '90D')
    .not('handle', 'is', null)
    .range(offset, offset + TRADERS_PER_SHARD - 1)

  const seen = new Set<string>()
  const entries = (data || [])
    .map((t) => t.handle || t.source_trader_id)
    .filter((h): h is string => !!h && !seen.has(h) && (seen.add(h), true))
    .map((h) => ({
      loc: `${BASE_URL}/trader/${encodeURIComponent(h)}`,
      lastmod: now,
      changefreq: 'daily',
      priority: 0.8,
    }))

  return xmlResponse(urlsetXml(entries))
}

async function getTraderCount(): Promise<number> {
  try {
    const supabase = getSupabase()
    const { count } = await supabase
      .from('leaderboard_ranks')
      .select('id', { count: 'exact', head: true })
      .eq('season_id', '90D')
      .not('handle', 'is', null)
    return count || 0
  } catch {
    return 5000
  }
}

function urlsetXml(
  entries: Array<{ loc: string; lastmod?: string; changefreq?: string; priority?: number }>
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${e.loc}</loc>
${e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>\n` : ''}${e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>\n` : ''}${e.priority !== undefined ? `    <priority>${e.priority}</priority>\n` : ''}  </url>`
  )
  .join('\n')}
</urlset>`
}
