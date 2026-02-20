#!/usr/bin/env node
/**
 * Gate.io CTA WR/MDD enricher - exhaustive pagination
 * 
 * CTA traders (cta_*) need win_rate computed from strategy_profit_list.
 * This script paginates ALL pages of the CTA API to find the 27 missing traders.
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

const TARGET_IDS = new Set([
  'cta_abluk24', 'cta_dragonsmallsmallsmal', 'cta_fireblue', 'cta_galaxyquant',
  'cta_gateuser061f1d13', 'cta_gateuser0eec98f2', 'cta_gateuser19f45b51',
  'cta_gateuser3893dd1b', 'cta_gateuser6ed1d847', 'cta_gateuser947625fb',
  'cta_gateuser96a07d2e', 'cta_gateusera1af57c1', 'cta_gateuserbf05e1e0',
  'cta_gateuserbfda99d2', 'cta_gateuserc864817e', 'cta_gateuserca120d12',
  'cta_gateuserd2e4499f', 'cta_gateuserfab06533', 'cta_gunmanzzz',
  'cta_loaitrx', 'cta_mossclothessleepdeer', 'cta_rayder', 'cta_rosesneverpanic',
  'cta_sensei', 'cta_slowisfast', 'cta_studen', 'cta_zhaocaiqi'
])

function computeId(nickname) {
  return 'cta_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
}

function computeStats(profitList) {
  if (!profitList || profitList.length < 2) return { wr: null, mdd: null }
  const sorted = [...profitList].sort((a, b) => a.trade_date - b.trade_date)
  
  // Win rate: % of days where daily change is positive
  let wins = 0, total = 0
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseFloat(sorted[i-1].profit || 0)
    const cur = parseFloat(sorted[i].profit || 0)
    const dailyChange = cur - prev
    total++
    if (dailyChange > 0) wins++
  }
  const wr = total > 0 ? (wins / total) * 100 : null

  // Max drawdown from profit_rate series
  const rates = sorted.map(d => parseFloat(d.profit_rate || 0))
  let peak = rates[0], mdd = 0
  for (const r of rates) {
    if (r > peak) peak = r
    const dd = peak - r
    if (dd > mdd) mdd = dd
  }
  
  return { wr, mdd }
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gate.io — CTA WR/MDD Enricher (exhaustive)`)
  console.log(`${'='.repeat(60)}`)

  // Verify which IDs still need enrichment
  const { data: missingRows } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .is('win_rate', null)

  const byTrader = new Map()
  for (const r of missingRows || []) {
    if (!byTrader.has(r.source_trader_id)) byTrader.set(r.source_trader_id, [])
    byTrader.get(r.source_trader_id).push(r)
  }
  console.log(`Rows with null win_rate: ${missingRows?.length}`)
  console.log(`Unique traders needed: ${byTrader.size}`)
  if (byTrader.size === 0) { console.log('Nothing to do'); return }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)

  // Check total count first
  const totalInfo = await page.evaluate(async () => {
    const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT')
    const j = await r.json()
    return { totalcount: j?.data?.totalcount, pagecount: j?.data?.pagecount, pagesize: j?.data?.pagesize }
  })
  console.log(`CTA API totals: ${JSON.stringify(totalInfo)}`)
  const totalPages = totalInfo.pagecount || 100

  // Paginate through ALL CTA traders
  const collected = new Map() // computedId -> { wr, mdd }
  const sortFields = ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT']
  let totalUnique = 0
  
  for (const sortField of sortFields) {
    let foundInThisSort = 0
    for (let pg = 1; pg <= Math.min(totalPages, 200); pg++) {
      const batch = await page.evaluate(async ({ pg, sortField }) => {
        try {
          const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=${sortField}`)
          const j = await r.json()
          if (j?.code !== 0) return null
          return j?.data?.list || []
        } catch { return [] }
      }, { pg, sortField })
      
      if (!batch || batch.length === 0) {
        console.log(`  ${sortField} page ${pg}: empty, stopping`)
        break
      }
      
      for (const t of batch) {
        const nick = t.nickname || ''
        if (!nick) continue
        const id = computeId(nick)
        if (collected.has(id)) continue
        
        const stats = computeStats(t.strategy_profit_list)
        collected.set(id, stats)
        foundInThisSort++
        
        if (TARGET_IDS.has(id)) {
          console.log(`  *** FOUND TARGET: ${id} (nickname: "${nick}") WR=${stats.wr?.toFixed(1)} MDD=${stats.mdd?.toFixed(2)} ***`)
        }
      }
      
      // Check if we found all targets
      const foundTargets = [...TARGET_IDS].filter(id => collected.has(id)).length
      if (foundTargets === TARGET_IDS.size) {
        console.log(`  All ${TARGET_IDS.size} targets found after page ${pg}!`)
        break
      }
      
      if (pg % 20 === 0) {
        const found = [...TARGET_IDS].filter(id => collected.has(id)).length
        console.log(`  ${sortField} page ${pg}: unique=${collected.size} targets_found=${found}/${TARGET_IDS.size}`)
      }
      
      await sleep(150)
    }
    
    const found = [...TARGET_IDS].filter(id => collected.has(id)).length
    console.log(`After ${sortField}: unique=${collected.size} targets=${found}/${TARGET_IDS.size} (+${foundInThisSort} new this sort)`)
    
    if (found === TARGET_IDS.size) break
  }

  await browser.close()
  
  const found = [...TARGET_IDS].filter(id => collected.has(id)).length
  console.log(`\nTotal unique CTA: ${collected.size}, targets found: ${found}/${TARGET_IDS.size}`)
  
  // Show which targets are still missing
  const stillMissing = [...TARGET_IDS].filter(id => !collected.has(id))
  if (stillMissing.length > 0) {
    console.log('Still missing:', stillMissing)
  }

  // Update DB
  console.log('\n── Updating DB ──')
  let updated = 0, skipped = 0

  for (const [traderId, rows] of byTrader) {
    const stats = collected.get(traderId)
    if (!stats || (stats.wr == null && stats.mdd == null)) {
      skipped++
      continue
    }
    
    for (const row of rows) {
      const updates = {}
      if (row.win_rate == null && stats.wr != null && !isNaN(stats.wr)) {
        updates.win_rate = parseFloat(stats.wr.toFixed(2))
      }
      if (row.max_drawdown == null && stats.mdd != null && !isNaN(stats.mdd)) {
        updates.max_drawdown = parseFloat(stats.mdd.toFixed(2))
      }
      if (Object.keys(updates).length === 0) { skipped++; continue }
      
      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) {
        updated++
        console.log(`  ✓ ${traderId} ${row.season_id}: wr=${updates.win_rate ?? '-'} mdd=${updates.max_drawdown ?? '-'}`)
      } else {
        console.error(`  ✗ ${traderId}: ${error.message}`)
      }
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped: ${skipped}`)

  // Final verification
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  console.log(`\nFinal: wr_null=${wrNull} mdd_null=${mddNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
