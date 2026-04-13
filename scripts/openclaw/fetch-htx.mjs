#!/usr/bin/env node
/**
 * HTX Copy Trading Fetcher — Mac Mini (residential IP)
 *
 * HTX's futures.htx.com API is geo-blocked from all datacenter IPs
 * (Vercel hnd1, VPS SG, VPS JP all return 403/empty).
 * Mac Mini with residential IP connects directly (200, 175ms).
 *
 * API: GET https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
 * Params: rankType=1, pageNo=N, pageSize=50
 * Response: { code: 200, data: { totalNum, itemList: [...] } }
 * Fields: uid, nickName, imgUrl, copyUserNum, fullUserNum, winRate (string 0-1),
 *         profitRate90 (string percent), profit90, aum, mdd (string percent)
 *
 * Schedule: Mac Mini crontab every 4h (matches vercel.json d1b group)
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { validateRow } from './validate-snapshot.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PLATFORM = 'htx_futures'
const PAGE_SIZE = 50
const MAX_PAGES = 10 // 500 traders max
const WINDOWS = ['7d', '30d', '90d']

const log = (...args) => console.log(`[${new Date().toISOString().substring(11, 19)}] [htx]`, ...args)

async function fetchLeaderboard() {
  const allTraders = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const url = `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=${PAGE_SIZE}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        log(`Page ${page}: HTTP ${res.status}`)
        break
      }
      const json = await res.json()
      const items = json?.data?.itemList || []
      if (items.length === 0) break

      for (const item of items) {
        const uid = String(item.uid || item.userSign || '')
        if (!uid) continue
        allTraders.push({
          uid,
          nickname: item.nickName || '',
          avatar: item.imgUrl || '',
          copiers: item.copyUserNum || 0,
          winRate: parseFloat(item.winRate || '0') * 100, // 0-1 → 0-100
          roi90: parseFloat(item.profitRate90 || '0'),    // already percent
          pnl90: parseFloat(item.profit90 || '0'),
          aum: parseFloat(item.aum || '0'),
          mdd: parseFloat(item.mdd || '0') * 100,        // 0-1 → 0-100
        })
      }
      log(`Page ${page}: ${items.length} traders (total: ${allTraders.length})`)
      if (items.length < PAGE_SIZE) break
    } catch (err) {
      log(`Page ${page} error: ${err.message}`)
      break
    }
  }
  return allTraders
}

async function saveTraders(traders) {
  if (traders.length === 0) return { total: 0, saved: 0 }

  let saved = 0
  let rejected = 0

  for (const window of WINDOWS) {
    // Truncate as_of_ts to hour (matches storage.ts key generation for upsert dedup)
    const now = new Date()
    now.setUTCMinutes(0, 0, 0)
    const asOfTs = now.toISOString()

    const rows = traders.map(t => ({
      platform: PLATFORM,
      market_type: 'futures',
      trader_key: t.uid,
      window: window.toUpperCase(),
      roi_pct: t.roi90,
      pnl_usd: t.pnl90,
      win_rate: t.winRate,
      max_drawdown: t.mdd,
      followers: t.copiers,
      copiers: t.copiers,
      as_of_ts: asOfTs,
    }))

    // Validate
    const validRows = []
    for (const row of rows) {
      const v = validateRow(row)
      if (v.valid) {
        validRows.push(row)
      } else {
        rejected++
      }
    }

    if (validRows.length === 0) continue

    // Batch upsert
    for (let i = 0; i < validRows.length; i += 50) {
      const batch = validRows.slice(i, i + 50)
      const { error } = await supabase
        .from('trader_snapshots_v2')
        .upsert(batch, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
      if (error) {
        log(`Upsert error (${window}): ${error.message}`)
      } else {
        saved += batch.length
      }
    }
  }

  return { total: traders.length, saved, rejected }
}

async function main() {
  log('Starting HTX fetch (residential IP)...')
  const traders = await fetchLeaderboard()
  log(`Fetched ${traders.length} traders`)

  if (traders.length === 0) {
    log('ERROR: 0 traders fetched — API may be down')
    process.exit(1)
  }

  const result = await saveTraders(traders)
  log(`Done: ${result.saved} rows saved, ${result.rejected} rejected`)
}

main().catch(err => {
  log('FATAL:', err.message)
  process.exit(1)
})
