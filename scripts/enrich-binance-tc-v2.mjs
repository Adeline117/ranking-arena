#!/usr/bin/env node
/**
 * Binance Futures - Enrich trades_count v2 (serial, via curl SOCKS proxy)
 */
import { createClient } from '@supabase/supabase-js'
import { exec } from 'child_process'
import { promisify } from 'util'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const execAsync = promisify(exec)
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTradesCount(portfolioId) {
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 15 -x socks5h://127.0.0.1:1080 --compressed -X POST 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/trade-history' -H 'User-Agent: Mozilla/5.0' -H 'Origin: https://www.binance.com' -H 'Content-Type: application/json' -d '{"portfolioId":"${portfolioId}","pageNumber":1,"pageSize":1}'`,
      { timeout: 20000 }
    )
    const j = JSON.parse(stdout)
    if (j.success && j.data?.total != null) return j.data.total
    return null
  } catch { return null }
}

async function main() {
  console.log('🚀 Binance Futures - Enrich trades_count v2 (serial)\n')

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

  const traderMap = new Map()
  for (const r of allRows) {
    if (!traderMap.has(r.source_trader_id)) traderMap.set(r.source_trader_id, [])
    traderMap.get(r.source_trader_id).push(r)
  }
  const traderIds = [...traderMap.keys()]
  console.log(`Remaining: ${allRows.length} rows, ${traderIds.length} unique traders\n`)

  let enriched = 0, failed = 0
  for (let i = 0; i < traderIds.length; i++) {
    const pid = traderIds[i]
    const tc = await getTradesCount(pid)
    
    if (tc != null) {
      await sb.from('leaderboard_ranks')
        .update({ trades_count: tc })
        .eq('source', 'binance_futures')
        .eq('source_trader_id', pid)
        .is('trades_count', null)
      await sb.from('trader_snapshots')
        .update({ trades_count: tc })
        .eq('source', 'binance_futures')
        .eq('source_trader_id', pid)
        .is('trades_count', null)
      enriched++
    } else {
      failed++
    }

    if ((i + 1) % 20 === 0) {
      console.log(`[${i+1}/${traderIds.length}] enriched=${enriched} failed=${failed}`)
    }
    await sleep(500)
  }

  console.log(`\n✅ Done: enriched=${enriched} failed=${failed}`)
  const { count } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'binance_futures').is('trades_count', null)
  console.log(`Remaining trades_count null: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
