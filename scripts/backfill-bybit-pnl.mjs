#!/usr/bin/env node
/**
 * Backfill Bybit PnL for traders missing it in trader_snapshots_v2.
 * Calls VPS scraper /bybit/trader-detail for each trader.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const VPS_HOST = (process.env.VPS_SCRAPER_SG || 'http://45.76.152.169:3457').replace(/\n$/, '').trim()
const VPS_KEY = (process.env.VPS_PROXY_KEY || '').trim()

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE env vars. Run: source .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function parseNum(v) {
  if (v == null) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

async function fetchPnl(leaderMark) {
  const url = `${VPS_HOST}/bybit/trader-detail?leaderMark=${encodeURIComponent(leaderMark)}`
  const res = await fetch(url, {
    headers: { 'X-Proxy-Key': VPS_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) return null
  const data = await res.json()
  const detail = data?.detail?.result
  if (!detail) return null
  return {
    pnl: parseNum(detail.pnl),
    pnl7d: parseNum(detail.pnl7d),
    pnl30d: parseNum(detail.pnl30d),
    pnl90d: parseNum(detail.pnl90d),
  }
}

async function main() {
  // Get all Bybit traders missing PnL
  const { data: traders, error } = await supabase
    .from('trader_snapshots_v2')
    .select('trader_key')
    .eq('platform', 'bybit')
    .is('pnl_usd', null)
    .gte('updated_at', new Date(Date.now() - 7 * 86400000).toISOString())

  if (error) { console.error('Query failed:', error.message); process.exit(1) }

  const uniqueKeys = [...new Set(traders.map(t => t.trader_key))]
  console.log(`Found ${uniqueKeys.length} Bybit traders missing PnL`)

  let success = 0, failed = 0, skipped = 0

  for (let i = 0; i < uniqueKeys.length; i++) {
    const key = uniqueKeys[i]
    try {
      const pnlData = await fetchPnl(key)
      if (!pnlData || (pnlData.pnl7d == null && pnlData.pnl30d == null && pnlData.pnl90d == null)) {
        skipped++
        continue
      }

      // Write per-period PnL
      const periodMap = { '7D': pnlData.pnl7d, '30D': pnlData.pnl30d, '90D': pnlData.pnl90d }
      for (const [window, pnl] of Object.entries(periodMap)) {
        const fallback = pnlData.pnl
        const value = pnl ?? fallback
        if (value != null) {
          await supabase
            .from('trader_snapshots_v2')
            .update({ pnl_usd: value })
            .eq('platform', 'bybit')
            .eq('trader_key', key)
            .eq('window', window)
        }
      }

      success++
      if ((i + 1) % 10 === 0) {
        console.log(`Progress: ${i + 1}/${uniqueKeys.length} (success=${success}, failed=${failed}, skipped=${skipped})`)
      }
    } catch (err) {
      failed++
      console.warn(`Failed ${key}: ${err.message}`)
    }

    // Delay: one at a time, VPS Playwright needs 15-45s per trader
    if (i < uniqueKeys.length - 1) {
      await new Promise(r => setTimeout(r, 8000))
    }
  }

  console.log(`\nDone: ${success} success, ${failed} failed, ${skipped} skipped out of ${uniqueKeys.length}`)
}

main().catch(console.error)
