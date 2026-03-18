import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('=== Backfill sharpe_ratio, max_drawdown, win_rate ===')
  
  // Step 1: Fetch all daily snapshots with ROI data (last 90 days)
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
  console.log(`Fetching daily snapshots since ${cutoff}...`)
  
  let allRows = []
  let offset = 0
  const PAGE = 10000
  while (true) {
    const { data, error } = await supabase
      .from('trader_daily_snapshots')
      .select('platform, trader_key, date, roi, daily_return_pct')
      .gte('date', cutoff)
      .order('date', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...data)
    offset += PAGE
    if (data.length < PAGE) break
  }
  console.log(`Fetched ${allRows.length} daily snapshot rows`)

  // Group by trader
  const byTrader = new Map()
  for (const row of allRows) {
    const key = `${row.platform}:${row.trader_key}`
    if (!byTrader.has(key)) byTrader.set(key, { rois: [], returns: [], platform: row.platform, trader_key: row.trader_key })
    const entry = byTrader.get(key)
    if (row.roi != null) entry.rois.push(parseFloat(String(row.roi)))
    if (row.daily_return_pct != null) entry.returns.push(parseFloat(String(row.daily_return_pct)))
  }
  console.log(`${byTrader.size} unique traders with daily data`)

  // Compute metrics
  const updates = []
  for (const [key, data] of byTrader) {
    const update = { platform: data.platform, trader_key: data.trader_key, sharpe_ratio: null, max_drawdown: null, win_rate: null }
    
    // Sharpe from daily returns (need 7+)
    if (data.returns.length >= 7) {
      const mean = data.returns.reduce((s, r) => s + r, 0) / data.returns.length
      const variance = data.returns.reduce((s, r) => s + (r - mean) ** 2, 0) / data.returns.length
      const stdDev = Math.sqrt(variance)
      if (stdDev > 0) {
        const sharpe = (mean / stdDev) * Math.sqrt(365)
        if (sharpe >= -10 && sharpe <= 10) update.sharpe_ratio = Math.round(sharpe * 100) / 100
      }
    }

    // MDD from ROI equity curve (need 3+)
    if (data.rois.length >= 3) {
      let peak = -Infinity, maxDD = 0
      for (const roi of data.rois) {
        const equity = 100 * (1 + roi / 100)
        if (equity > peak) peak = equity
        if (peak > 0) {
          const dd = ((peak - equity) / peak) * 100
          if (dd > maxDD) maxDD = dd
        }
      }
      if (maxDD > 0 && maxDD <= 100) update.max_drawdown = Math.round(maxDD * 100) / 100
    }

    // Win rate from daily returns (need 5+)
    if (data.returns.length >= 5) {
      const wins = data.returns.filter(r => r > 0).length
      update.win_rate = Math.round((wins / data.returns.length) * 1000) / 10
    }

    if (update.sharpe_ratio != null || update.max_drawdown != null || update.win_rate != null) {
      updates.push(update)
    }
  }
  console.log(`${updates.length} traders have computable metrics`)

  // Step 2: Update trader_snapshots_v2
  let v2Sharpe = 0, v2Mdd = 0, v2Wr = 0, errors = 0
  const BATCH = 20
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const promises = batch.map(async (upd) => {
      // Update sharpe where null
      if (upd.sharpe_ratio != null) {
        const { error } = await supabase
          .from('trader_snapshots_v2')
          .update({ sharpe_ratio: upd.sharpe_ratio })
          .eq('platform', upd.platform)
          .eq('trader_key', upd.trader_key)
          .is('sharpe_ratio', null)
        if (!error) v2Sharpe++; else errors++
      }
      // Update MDD where null
      if (upd.max_drawdown != null) {
        const { error } = await supabase
          .from('trader_snapshots_v2')
          .update({ max_drawdown: upd.max_drawdown })
          .eq('platform', upd.platform)
          .eq('trader_key', upd.trader_key)
          .is('max_drawdown', null)
        if (!error) v2Mdd++; else errors++
      }
      // Update win_rate where null
      if (upd.win_rate != null) {
        const { error } = await supabase
          .from('trader_snapshots_v2')
          .update({ win_rate: upd.win_rate })
          .eq('platform', upd.platform)
          .eq('trader_key', upd.trader_key)
          .is('win_rate', null)
        if (!error) v2Wr++; else errors++
      }
    })
    await Promise.all(promises)
    if ((i + BATCH) % 500 === 0 || i + BATCH >= updates.length) {
      console.log(`Progress: ${Math.min(i + BATCH, updates.length)}/${updates.length} | sharpe=${v2Sharpe} mdd=${v2Mdd} wr=${v2Wr} errors=${errors}`)
    }
  }

  // Step 3: Also update legacy trader_snapshots
  let v1Sharpe = 0, v1Mdd = 0, v1Wr = 0
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const promises = batch.map(async (upd) => {
      if (upd.sharpe_ratio != null) {
        const { error } = await supabase
          .from('trader_snapshots')
          .update({ sharpe_ratio: upd.sharpe_ratio })
          .eq('source', upd.platform)
          .eq('source_trader_id', upd.trader_key)
          .is('sharpe_ratio', null)
        if (!error) v1Sharpe++
      }
      if (upd.max_drawdown != null) {
        const { error } = await supabase
          .from('trader_snapshots')
          .update({ max_drawdown: upd.max_drawdown })
          .eq('source', upd.platform)
          .eq('source_trader_id', upd.trader_key)
          .is('max_drawdown', null)
        if (!error) v1Mdd++
      }
      if (upd.win_rate != null) {
        const { error } = await supabase
          .from('trader_snapshots')
          .update({ win_rate: upd.win_rate })
          .eq('source', upd.platform)
          .eq('source_trader_id', upd.trader_key)
          .is('win_rate', null)
        if (!error) v1Wr++
      }
    })
    await Promise.all(promises)
  }

  console.log('\n=== DONE ===')
  console.log(`v2: sharpe=${v2Sharpe} mdd=${v2Mdd} wr=${v2Wr}`)
  console.log(`v1: sharpe=${v1Sharpe} mdd=${v1Mdd} wr=${v1Wr}`)
  console.log(`Errors: ${errors}`)

  // Step 4: Also backfill daily_return_pct from ROI delta where it's null
  console.log('\n=== Backfilling daily_return_pct from ROI delta ===')
  // For each trader, compute ROI delta between consecutive days
  let returnsFilled = 0
  const returnUpdates = []
  for (const [key, data] of byTrader) {
    // Get all rows for this trader sorted by date
    const traderRows = allRows.filter(r => `${r.platform}:${r.trader_key}` === key && r.roi != null)
      .sort((a, b) => a.date.localeCompare(b.date))
    
    for (let j = 1; j < traderRows.length; j++) {
      if (traderRows[j].daily_return_pct != null) continue // already has value
      const prevRoi = parseFloat(String(traderRows[j-1].roi))
      const curRoi = parseFloat(String(traderRows[j].roi))
      if (isNaN(prevRoi) || isNaN(curRoi)) continue
      const dailyReturn = curRoi - prevRoi
      returnUpdates.push({
        platform: data.platform,
        trader_key: data.trader_key,
        date: traderRows[j].date,
        daily_return_pct: Math.round(dailyReturn * 100) / 100,
      })
    }
  }

  console.log(`${returnUpdates.length} daily_return_pct values to backfill`)
  for (let i = 0; i < returnUpdates.length; i += 100) {
    const batch = returnUpdates.slice(i, i + 100)
    const { error } = await supabase
      .from('trader_daily_snapshots')
      .upsert(batch, { onConflict: 'platform,trader_key,date', ignoreDuplicates: false })
    if (!error) returnsFilled += batch.length
    if ((i + 100) % 1000 === 0) console.log(`daily_return_pct: ${Math.min(i + 100, returnUpdates.length)}/${returnUpdates.length}`)
  }
  console.log(`Backfilled ${returnsFilled} daily_return_pct values`)
}

main().catch(console.error)
