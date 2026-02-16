#!/usr/bin/env node
/**
 * Bitget Spot Enrichment via Playwright
 * Uses /v1/trace/spot/trader/traderDetailPage to get winRate and tradeBi
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '300')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function enrichTrader(page, traderId) {
  let detail = null
  
  const handler = async (resp) => {
    if (resp.status() !== 200) return
    if (resp.url().includes('traderDetailPage')) {
      try { detail = await resp.json() } catch {}
    }
  }
  
  page.on('response', handler)
  
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${traderId}/spot`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    )
    for (let i = 0; i < 12; i++) {
      if (detail) break
      await sleep(500)
    }
  } catch {}
  
  page.removeListener('response', handler)
  
  if (!detail?.data?.traderDataVo?.allData) return null
  
  const d = detail.data.traderDataVo.allData
  let wr = parseFloat(d.winningRate)
  if (isNaN(wr)) wr = null
  if (wr != null && wr > 0 && wr <= 1) wr *= 100
  
  let tc = parseInt(d.tradeBi)
  if (isNaN(tc)) tc = null
  
  return { wr, tc }
}

async function main() {
  console.log(`🔄 Bitget Spot Enrichment (limit=${LIMIT})\n`)
  
  const { data: allRows } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, trades_count')
    .eq('source', 'bitget_spot')
    .or('win_rate.is.null,trades_count.is.null')
    .order('arena_score', { ascending: false })
  
  const seen = new Set()
  const traders = allRows.filter(r => {
    if (seen.has(r.source_trader_id)) return false
    seen.add(r.source_trader_id)
    return r.source_trader_id && r.source_trader_id.length > 10
  }).slice(0, LIMIT)
  
  console.log(`Found ${traders.length} unique traders to enrich\n`)
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', route => route.abort())

  let enriched = 0, noData = 0
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    try {
      const stats = await enrichTrader(page, t.source_trader_id)
      
      if (stats && (stats.wr != null || stats.tc != null)) {
        const updates = {}
        if (stats.wr != null && t.win_rate == null) updates.win_rate = stats.wr
        if (stats.tc != null && t.trades_count == null) updates.trades_count = stats.tc
        
        if (Object.keys(updates).length) {
          await sb.from('leaderboard_ranks').update(updates)
            .eq('source', 'bitget_spot').eq('source_trader_id', t.source_trader_id)
          await sb.from('trader_snapshots').update(updates)
            .eq('source', 'bitget_spot').eq('source_trader_id', t.source_trader_id)
          enriched++
          if ((i+1) % 25 === 0) console.log(`[${i+1}/${traders.length}] enriched=${enriched} noData=${noData}`)
        } else {
          noData++
        }
      } else {
        noData++
      }
    } catch (e) {
      noData++
    }
    
    await sleep(5000)
    
    if (i >= 15 && enriched === 0) {
      console.log('⛔ 10 attempts with 0 enrichment. Stopping.')
      break
    }
  }
  
  await browser.close()
  
  console.log(`\n✅ Done: enriched=${enriched} noData=${noData}`)
  
  // Verify
  const { count: total } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitget_spot')
  const { count: noWR } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitget_spot').is('win_rate', null)
  const { count: noTC } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitget_spot').is('trades_count', null)
  console.log(`Verify: total=${total} wr_null=${noWR} tc_null=${noTC}`)
}

main().catch(e => { console.error(e); process.exit(1) })
