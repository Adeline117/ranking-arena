#!/usr/bin/env node
/**
 * Binance Futures - Enrich trades_count via trade-history API (POST)
 * Uses SOCKS proxy via VPS: ssh -D 1080 -N -f root@45.76.152.169
 */
import { createClient } from '@supabase/supabase-js'
import https from 'https'
import { SocksProxyAgent } from 'socks-proxy-agent'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const agent = new SocksProxyAgent('socks5://127.0.0.1:1080')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTradesCount(portfolioId) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ portfolioId, pageNumber: 1, pageSize: 1 })
    const req = https.request({
      hostname: 'www.binance.com',
      path: '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/trade-history',
      method: 'POST',
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Accept-Encoding': 'identity',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const j = JSON.parse(data)
          if (j.success && j.data?.total != null) resolve(j.data.total)
          else resolve(null)
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(postData)
    req.end()
  })
}

async function main() {
  console.log('🚀 Binance Futures - Enrich trades_count\n')

  // Get all rows needing trades_count
  let allRows = []
  let offset = 0
  while (true) {
    const { data } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id')
      .eq('source', 'binance_futures')
      .is('trades_count', null)
      .range(offset, offset + 999)
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`Rows needing trades_count: ${allRows.length}`)

  // Dedupe
  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  const traderIds = [...traderMap.keys()]
  console.log(`Unique traders: ${traderIds.length}\n`)

  let enriched = 0, failed = 0
  const BATCH = 10

  for (let i = 0; i < traderIds.length; i += BATCH) {
    const batch = traderIds.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async (pid) => {
      const tc = await getTradesCount(pid)
      return { pid, tc }
    }))

    for (const { pid, tc } of results) {
      if (tc != null) {
        // Update leaderboard_ranks
        await sb.from('leaderboard_ranks')
          .update({ trades_count: tc })
          .eq('source', 'binance_futures')
          .eq('source_trader_id', pid)
          .is('trades_count', null)
        // Update trader_snapshots too
        await sb.from('trader_snapshots')
          .update({ trades_count: tc })
          .eq('source', 'binance_futures')
          .eq('source_trader_id', pid)
          .is('trades_count', null)
        enriched++
      } else {
        failed++
      }
    }

    if ((i + BATCH) % 100 < BATCH) {
      console.log(`[${Math.min(i + BATCH, traderIds.length)}/${traderIds.length}] enriched=${enriched} failed=${failed}`)
    }
    await sleep(200)
  }

  console.log(`\n✅ Done: enriched=${enriched} failed=${failed}`)

  // Verify
  const { count: tcNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'binance_futures').is('trades_count', null)
  console.log(`Remaining trades_count null: ${tcNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
