#!/usr/bin/env node
/**
 * Gate.io: Fill null max_drawdown for numeric (futures) leader IDs
 * Uses /apiw/v2/copy/leader/detail per trader + list API with stopped status
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

async function main() {
  console.log('=== Gate.io Numeric MDD Enricher ===')

  // Get numeric traders with null max_drawdown
  const { data: rows } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .is('max_drawdown', null)
    .not('source_trader_id', 'like', 'cta_%')

  const byTrader = new Map()
  for (const r of rows || []) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  const traderIds = [...byTrader.keys()]
  console.log(`Numeric traders with null MDD: ${traderIds.length} unique, ${rows?.length} rows`)
  if (!traderIds.length) return

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)

  const collected = new Map() // leaderId -> { wr, mdd }

  // Strategy 1: Paginate list API with ALL statuses and cycles
  console.log('\n── Strategy 1: Full list pagination (all statuses) ──')
  const cycles = ['week', 'month', 'quarter']
  const statuses = ['running', 'paused', 'stopped', '']
  const orderBys = ['profit_rate', 'win_rate', 'max_drawdown', 'aum', 'follow_profit']
  
  for (const cycle of cycles) {
    for (const orderBy of orderBys.slice(0, 2)) { // Limit to 2 orderBys per cycle
      for (let pg = 1; pg <= 30; pg++) {
        const statusParam = statuses.map(s => s ? `&status=${s}` : '').join('')
        const r = await page.evaluate(async ({ pg, cycle, orderBy }) => {
          try {
            const url = `/apiw/v2/copy/leader/list?page=${pg}&page_size=100&cycle=${cycle}&order_by=${orderBy}&sort_by=desc`
            const resp = await fetch(url)
            const j = await resp.json()
            return j?.data?.list || []
          } catch { return [] }
        }, { pg, cycle, orderBy })
        
        if (!r || r.length === 0) break
        
        for (const t of r) {
          const id = String(t.leader_id || '')
          if (!id) continue
          let wr = t.win_rate != null ? parseFloat(t.win_rate) * 100 : null
          let mdd = t.max_drawdown != null ? Math.abs(parseFloat(t.max_drawdown)) * 100 : null
          if (!collected.has(id) || collected.get(id).mdd == null) {
            collected.set(id, { wr, mdd })
          }
        }
        await sleep(200)
        if (r.length < 100) break
      }
    }
    const found = traderIds.filter(id => collected.has(id) && collected.get(id).mdd != null).length
    console.log(`  After ${cycle}: found ${found}/${traderIds.length}`)
  }

  // Strategy 2: Individual detail API for missing
  const stillMissing = traderIds.filter(id => !collected.has(id) || collected.get(id).mdd == null)
  console.log(`\n── Strategy 2: Detail API for ${stillMissing.length} traders ──`)
  
  for (let i = 0; i < stillMissing.length; i++) {
    const traderId = stillMissing[i]
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${stillMissing.length}`)
    
    const detail = await page.evaluate(async (leaderId) => {
      try {
        const r = await fetch(`/apiw/v2/copy/leader/detail?leader_id=${leaderId}`)
        const j = await r.json()
        if (j?.code !== 0 || !j?.data) return null
        const d = j.data
        return {
          wr: d.win_rate != null ? parseFloat(d.win_rate) * 100 : null,
          mdd: d.max_drawdown != null ? Math.abs(parseFloat(d.max_drawdown)) * 100 : null,
        }
      } catch { return null }
    }, traderId)
    
    if (detail && (detail.wr != null || detail.mdd != null)) {
      collected.set(traderId, detail)
      console.log(`  Found ${traderId}: wr=${detail.wr?.toFixed(1)} mdd=${detail.mdd?.toFixed(2)}`)
    }
    await sleep(300)
  }

  await browser.close()

  // Update DB
  console.log('\n── Updating DB ──')
  let updated = 0, skipped = 0
  
  for (const [traderId, rows] of byTrader) {
    const stats = collected.get(traderId)
    if (!stats || stats.mdd == null) { skipped++; continue }
    
    for (const row of rows) {
      if (row.max_drawdown != null) { skipped++; continue }
      const { error } = await supabase
        .from('leaderboard_ranks')
        .update({ max_drawdown: parseFloat(stats.mdd.toFixed(2)) })
        .eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${traderId} ${row.season_id}: mdd=${stats.mdd.toFixed(2)}`)
      }
    }
  }
  
  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}`)
  
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  console.log(`Final: wr_null=${wrNull} mdd_null=${mddNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
