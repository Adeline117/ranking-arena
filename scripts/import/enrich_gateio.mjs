/**
 * Gate.io Enrichment Script
 * Fills missing win_rate and max_drawdown for futures traders by fetching detail data.
 * CTA traders have no detail API - we mark them with default values or skip.
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gateio'

async function main() {
  // 1. Get all seasons
  const seasons = ['7D', '30D', '90D']
  
  // 2. Count missing data
  for (const season of seasons) {
    const { count: totalMissing } = await supabase
      .from('trader_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('source', SOURCE)
      .eq('season_id', season)
      .or('win_rate.is.null,max_drawdown.is.null')
    console.log(`${season}: ${totalMissing} traders missing WR/MDD`)
  }

  // 3. Launch browser and fetch full leader list with WR/MDD
  console.log('\n🚀 Launching Playwright to fetch detail data...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  const page = await context.newPage()

  try {
    // Navigate to establish session
    console.log('  Navigating to gate.io...')
    await page.goto('https://www.gate.io/copytrading', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(e => console.log('  ⚠ Nav:', e.message))
    await sleep(8000)
    console.log('  Page title:', await page.title().catch(() => '?'))

    // Fetch ALL futures traders across all sort orders and cycles
    // The list API returns win_rate and max_drawdown
    console.log('\n--- Fetching futures traders with all details ---')
    
    // Gate.io API only supports cycle=month reliably
    // But the data (WR/MDD) is trader-level, not period-specific, so we can apply to all seasons
    for (const cycle of ['month']) {
      const seasonsToUpdate = ['7D', '30D', '90D']
      
      const tradersMap = await page.evaluate(async (cycle) => {
        const traders = {}
        const sortOrders = ['profit_rate', 'profit', 'aum', 'sharp_ratio', 'max_drawdown', 'follow_profit', 'win_rate']
        
        for (const orderBy of sortOrders) {
          for (let pg = 1; pg <= 15; pg++) {
            try {
              const r = await fetch(`/apiw/v2/copy/leader/list?page=${pg}&page_size=100&status=running&order_by=${orderBy}&sort_by=desc&cycle=${cycle}`)
              const j = await r.json()
              const list = j?.data?.list || []
              if (list.length === 0) break
              for (const t of list) {
                const id = String(t.leader_id)
                if (traders[id]) continue
                traders[id] = {
                  traderId: id,
                  winRate: t.win_rate ? parseFloat(t.win_rate) * 100 : null,
                  maxDrawdown: t.max_drawdown ? parseFloat(t.max_drawdown) * 100 : null,
                  roi: parseFloat(t.profit_rate || 0) * 100,
                  pnl: parseFloat(t.profit || 0),
                  tradeCount: t.order_num ? parseInt(t.order_num) : null,
                }
              }
            } catch { break }
          }
          // Small delay between sort orders
          await new Promise(r => setTimeout(r, 500))
        }
        return traders
      }, cycle)

      const traders = Object.values(tradersMap)
      const withWR = traders.filter(t => t.winRate !== null && t.winRate > 0)
      const withMDD = traders.filter(t => t.maxDrawdown !== null && t.maxDrawdown > 0)
      const withTC = traders.filter(t => t.tradeCount !== null && t.tradeCount > 0)
      console.log(`  Fetched ${traders.length} traders, ${withWR.length} with WR, ${withMDD.length} with MDD, ${withTC.length} with TC`)

      // Update DB for all seasons
      for (const season of seasonsToUpdate) {
        let updated = 0
        for (const t of traders) {
          if (t.winRate === null && t.maxDrawdown === null) continue
          
          const updateFields = {}
          if (t.winRate !== null) updateFields.win_rate = t.winRate
          if (t.maxDrawdown !== null) updateFields.max_drawdown = t.maxDrawdown
          
          const { data: existing } = await supabase
            .from('trader_snapshots')
            .select('roi, pnl, win_rate, max_drawdown')
            .eq('source', SOURCE)
            .eq('source_trader_id', t.traderId)
            .eq('season_id', season)
            .single()
          
          if (!existing) continue
          
          // Skip if already has data
          if (existing.win_rate !== null && existing.max_drawdown !== null) continue
          
          const newWR = updateFields.win_rate ?? existing.win_rate
          const newMDD = updateFields.max_drawdown ?? existing.max_drawdown
          const scores = calculateArenaScore(existing.roi, existing.pnl, newMDD, newWR, season)
          updateFields.arena_score = scores.totalScore

          const { error } = await supabase
            .from('trader_snapshots')
            .update(updateFields)
            .eq('source', SOURCE)
            .eq('source_trader_id', t.traderId)
            .eq('season_id', season)
          
          if (!error) updated++
        }
        console.log(`  ✅ ${season}: Updated ${updated} traders`)
      }
    }

    // Now try to get CTA trader details - check if there's a detail endpoint
    console.log('\n--- Checking CTA trader detail API ---')
    const ctaSample = await page.evaluate(async () => {
      // Try fetching CTA list with more fields
      try {
        const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=5&sort_field=NINETY_PROFIT_RATE_SORT')
        const j = await r.json()
        const list = j?.data?.list || []
        if (list.length > 0) {
          // Return all fields of first trader to inspect
          return { sample: list[0], keys: Object.keys(list[0]) }
        }
      } catch {}
      return null
    })
    
    if (ctaSample) {
      console.log('  CTA sample keys:', ctaSample.keys.join(', '))
      const s = ctaSample.sample
      console.log('  CTA sample fields:', JSON.stringify({
        win_rate: s.win_rate, max_drawdown: s.max_drawdown, mdd: s.mdd,
        trade_count: s.trade_count, order_num: s.order_num,
        ninety_win_rate: s.ninety_win_rate, thirty_win_rate: s.thirty_win_rate,
      }))
    }

    // Try spot copy trading detail
    console.log('\n--- Checking Spot trader detail API ---')
    const spotSample = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/copytrade/spot-copy-trading/trader/profit?page=1&page_size=3&order_by=profit_rate&sort_by=desc&cycle=month')
        const j = await r.json()
        const list = j?.data?.list || []
        if (list.length > 0) {
          return { sample: list[0], keys: Object.keys(list[0]) }
        }
      } catch {}
      return null
    })
    
    if (spotSample) {
      console.log('  Spot sample keys:', spotSample.keys.join(', '))
    }

    await browser.close()
  } catch (e) {
    console.error('Error:', e.message)
    await browser.close()
  }

  // 4. Final verification
  console.log('\n📊 Final verification:')
  for (const season of seasons) {
    const { count: total } = await supabase
      .from('trader_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('source', SOURCE)
      .eq('season_id', season)
    
    const { count: hasWR } = await supabase
      .from('trader_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('source', SOURCE)
      .eq('season_id', season)
      .not('win_rate', 'is', null)
    
    const { count: hasMDD } = await supabase
      .from('trader_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('source', SOURCE)
      .eq('season_id', season)
      .not('max_drawdown', 'is', null)
    
    const wrPct = ((hasWR / total) * 100).toFixed(0)
    const mddPct = ((hasMDD / total) * 100).toFixed(0)
    console.log(`  ${season}: ${total} total, WR=${wrPct}% (${hasWR}/${total}), MDD=${mddPct}% (${hasMDD}/${total})`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
