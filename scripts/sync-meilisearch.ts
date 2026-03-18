#!/usr/bin/env npx tsx
/**
 * Sync trader data from Supabase → Meilisearch for instant search.
 *
 * Usage:
 *   npx tsx scripts/sync-meilisearch.ts
 *   # or via cron: every 30 min after leaderboard compute
 *
 * Meilisearch provides typo-tolerant, instant search across 34K+ traders
 * with faceted filtering by exchange, period, and score range.
 *
 * Inspired by meilisearch/meilisearch (56K★).
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const MEILI_URL = process.env.MEILISEARCH_URL || 'http://45.76.152.169:7700'
const MEILI_KEY = process.env.MEILISEARCH_ADMIN_KEY || 'f8c03231fcfee43eccd5fb028ad7971d581ec0a7fa071c3bd711dc5491b3951d'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

interface MeiliTrader {
  id: string
  handle: string
  platform: string
  platform_name: string
  roi: number
  pnl: number
  arena_score: number
  win_rate: number | null
  max_drawdown: number | null
  followers: number | null
  rank: number
  trader_type: string | null
  avatar_url: string | null
  updated_at: string
}

async function meiliRequest(path: string, method: string, body?: unknown) {
  const res = await fetch(`${MEILI_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MEILI_KEY}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meilisearch ${method} ${path}: ${res.status} ${text}`)
  }
  return res.json()
}

async function setupIndex() {
  try {
    await meiliRequest('/indexes/traders', 'POST', {
      uid: 'traders',
      primaryKey: 'id',
    })
  } catch {
    // Index may already exist
  }

  // Configure searchable attributes and ranking rules
  await meiliRequest('/indexes/traders/settings', 'PATCH', {
    searchableAttributes: ['handle', 'platform_name', 'platform'],
    filterableAttributes: ['platform', 'trader_type', 'arena_score', 'roi', 'rank'],
    sortableAttributes: ['arena_score', 'roi', 'pnl', 'rank', 'followers'],
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'arena_score:desc',
    ],
    typoTolerance: {
      enabled: true,
      minWordSizeForTypos: { oneTypo: 3, twoTypos: 6 },
    },
    pagination: { maxTotalHits: 5000 },
  })

  console.log('Index configured')
}

async function syncTraders() {
  console.log('Fetching traders from Supabase...')

  // Fetch in pages (Supabase default limit is 1000)
  const allData: Record<string, unknown>[] = []
  let offset = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score, win_rate, max_drawdown, followers, rank, trader_type, computed_at')
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .order('arena_score', { ascending: false })
      .range(offset, offset + pageSize - 1)

    if (error) throw new Error(`Supabase query failed: ${error.message}`)
    if (!data || data.length === 0) break
    allData.push(...data)
    console.log(`  Fetched page ${Math.floor(offset / pageSize) + 1}: ${data.length} rows (total: ${allData.length})`)
    if (data.length < pageSize) break
    offset += pageSize
  }
  const data = allData

  const EXCHANGE_NAMES: Record<string, string> = {
    binance_futures: 'Binance', bybit: 'Bybit', bitget_futures: 'Bitget',
    okx_futures: 'OKX', mexc: 'MEXC', htx_futures: 'HTX', coinex: 'CoinEx',
    bingx: 'BingX', gateio: 'Gate.io', hyperliquid: 'Hyperliquid',
    gmx: 'GMX', dydx: 'dYdX', drift: 'Drift', aevo: 'Aevo',
    gains: 'Gains', jupiter_perps: 'Jupiter', etoro: 'eToro',
    binance_spot: 'Binance Spot', btcc: 'BTCC', bitfinex: 'Bitfinex',
    bitunix: 'Bitunix', blofin: 'BloFin', web3_bot: 'Web3 Bot',
  }

  const traders: MeiliTrader[] = (data || []).map((r: Record<string, unknown>) => ({
    // Meilisearch IDs must be alphanumeric + hyphens + underscores (no colons or 0x)
    id: `${String(r.source)}--${String(r.source_trader_id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    handle: String(r.handle || r.source_trader_id || ''),
    platform: String(r.source || ''),
    platform_name: EXCHANGE_NAMES[String(r.source || '')] || String(r.source || ''),
    roi: Number(r.roi ?? 0),
    pnl: Number(r.pnl ?? 0),
    arena_score: Number(r.arena_score ?? 0),
    win_rate: r.win_rate != null ? Number(r.win_rate) : null,
    max_drawdown: r.max_drawdown != null ? Number(r.max_drawdown) : null,
    followers: r.followers != null ? Number(r.followers) : null,
    rank: Number(r.rank ?? 0),
    trader_type: r.trader_type ? String(r.trader_type) : null,
    avatar_url: r.avatar_url ? String(r.avatar_url) : null,
    updated_at: String(r.computed_at || new Date().toISOString()),
  }))

  console.log(`Syncing ${traders.length} traders to Meilisearch...`)

  // Batch in chunks of 5000
  for (let i = 0; i < traders.length; i += 5000) {
    const chunk = traders.slice(i, i + 5000)
    const task = await meiliRequest('/indexes/traders/documents', 'POST', chunk)
    console.log(`Batch ${Math.floor(i / 5000) + 1}: taskUid=${task.taskUid}`)
  }

  console.log(`Done! ${traders.length} traders synced.`)
}

async function main() {
  console.log(`Meilisearch URL: ${MEILI_URL}`)

  // Check health
  const health = await meiliRequest('/health', 'GET')
  console.log('Health:', health)

  await setupIndex()
  await syncTraders()
}

main().catch(err => {
  console.error('Sync failed:', err)
  process.exit(1)
})
