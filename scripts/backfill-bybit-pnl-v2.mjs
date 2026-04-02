#!/usr/bin/env node
/**
 * Backfill Bybit PnL v2 — resilient version with retry + VPS health check.
 * Waits for VPS to be idle before each request.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const VPS_HOST = 'http://45.76.152.169:3457'
const VPS_KEY = (process.env.VPS_PROXY_KEY || '').trim()

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE env vars'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseNum(v) {
  if (v == null) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

async function waitForVps(maxBusy = 3) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${VPS_HOST}/health`, {
        headers: { 'X-Proxy-Key': VPS_KEY },
        signal: AbortSignal.timeout(5000),
      })
      const h = await res.json()
      if (h.pool.busy <= maxBusy) return true
      console.log(`  VPS busy (${h.pool.busy}/${h.pool.size}), waiting...`)
    } catch { /* VPS unreachable, wait */ }
    await sleep(10000)
  }
  return false
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

async function fetchWithRetry(key, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitForVps(2) // Wait until <=2 busy
      const result = await fetchPnl(key)
      return result
    } catch (err) {
      console.warn(`  Attempt ${attempt}/${maxRetries} failed for ${key.slice(0,10)}...: ${err.message}`)
      if (attempt < maxRetries) await sleep(15000) // Wait 15s before retry
    }
  }
  return null
}

async function main() {
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
    const pnlData = await fetchWithRetry(key)

    if (!pnlData || (pnlData.pnl7d == null && pnlData.pnl30d == null && pnlData.pnl90d == null && pnlData.pnl == null)) {
      failed++
      console.warn(`✗ ${i+1}/${uniqueKeys.length} ${key.slice(0,12)}... — no PnL data from API`)
      continue
    }

    const periodMap = { '7D': pnlData.pnl7d, '30D': pnlData.pnl30d, '90D': pnlData.pnl90d }
    let updated = 0
    for (const [window, pnl] of Object.entries(periodMap)) {
      const value = pnl ?? pnlData.pnl
      if (value != null) {
        const { count } = await supabase
          .from('trader_snapshots_v2')
          .update({ pnl_usd: value })
          .eq('platform', 'bybit')
          .eq('trader_key', key)
          .eq('window', window)
          .is('pnl_usd', null)
          .select('id', { count: 'exact', head: true })
        updated += count || 0
      }
    }

    success++
    if ((i + 1) % 5 === 0 || i === uniqueKeys.length - 1) {
      console.log(`✓ ${i+1}/${uniqueKeys.length} — success=${success} failed=${failed} (${updated} rows updated for ${key.slice(0,12)}...)`)
    }

    await sleep(5000) // 5s between requests
  }

  console.log(`\n=== Done: ${success} success, ${failed} failed out of ${uniqueKeys.length} ===`)
}

main().catch(console.error)
