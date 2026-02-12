/**
 * Enrich LBank traders with Win Rate, MDD, and Trade Count
 * 
 * LBank SSR __NEXT_DATA__ contains: winRate, omWinRate, swinRate, drawDown, tradeCount
 * Many traders already have this data; this script fills gaps.
 * 
 * Usage: node scripts/import/enrich_lbank_wr_mdd.mjs
 */
import { getSupabaseClient, calculateArenaScore } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

async function main() {
  console.log('LBank WR/MDD/TC enrichment\n')

  // Get existing lbank traders needing enrichment
  const { data: dbTraders } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, roi, pnl')
    .eq('source', 'lbank')

  console.log(`DB has ${dbTraders.length} lbank snapshot rows`)

  // Fetch SSR data
  console.log('Fetching LBank SSR data...')
  const resp = await fetch('https://www.lbank.com/copy-trading', { headers: HEADERS })
  const html = await resp.text()
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
  if (!match) throw new Error('__NEXT_DATA__ not found')
  const nextData = JSON.parse(match[1])
  const topTraders = nextData?.props?.pageProps?.topTraders
  if (!topTraders) throw new Error('topTraders not found')

  // Collect all trader data
  const traderData = new Map()
  for (const [key, value] of Object.entries(topTraders)) {
    const items = Array.isArray(value) ? value : value?.traderInfoResps || []
    for (const item of items) {
      const uuid = item.uuid || item.name || ''
      if (!uuid) continue
      if (traderData.has(uuid)) continue

      // Best WR: prefer omWinRate (30d), fall back to winRate, then swinRate
      let wr = null
      for (const f of ['omWinRate', 'winRate', 'swinRate']) {
        if (item[f] != null && item[f] !== '') {
          wr = parseFloat(item[f])
          if (!isNaN(wr)) break
          wr = null
        }
      }
      // Normalize: if 0-1 range, multiply
      if (wr != null && wr > 0 && wr <= 1) wr *= 100

      const dd = item.drawDown != null ? parseFloat(item.drawDown) : null
      const tc = item.tradeCount != null ? parseInt(item.tradeCount) : null

      // Also check bestTraders fields
      const wr7d = item.winRate7d != null ? parseFloat(item.winRate7d) : null
      const wr30d = item.winRate30d != null ? parseFloat(item.winRate30d) : null

      traderData.set(uuid, { wr, dd: dd != null && !isNaN(dd) ? dd : null, tc, wr7d, wr30d })
    }
  }

  console.log(`SSR data: ${traderData.size} traders with enrichment data`)

  // Update DB
  let updated = 0, noData = 0
  for (const row of dbTraders) {
    const data = traderData.get(row.source_trader_id)
    if (!data) { noData++; continue }

    const updateObj = {}
    if (data.wr != null && row.win_rate == null) {
      updateObj.win_rate = Math.round(data.wr * 100) / 100
    }
    if (data.dd != null && row.max_drawdown == null) {
      updateObj.max_drawdown = Math.round(Math.abs(data.dd) * 100) / 100
    }

    if (!Object.keys(updateObj).length) continue

    const newWR = updateObj.win_rate ?? row.win_rate
    const newMDD = updateObj.max_drawdown ?? row.max_drawdown
    updateObj.arena_score = calculateArenaScore(row.roi, row.pnl, newMDD, newWR, row.season_id).totalScore

    const { error } = await supabase
      .from('trader_snapshots')
      .update(updateObj)
      .eq('source', 'lbank')
      .eq('source_trader_id', row.source_trader_id)
      .eq('season_id', row.season_id)

    if (!error) updated++
  }

  console.log(`\n✅ Updated: ${updated}, No data: ${noData}`)

  // Verify
  for (const period of ['7D', '30D', '90D']) {
    const { data: v } = await supabase
      .from('trader_snapshots').select('win_rate,max_drawdown')
      .eq('source', 'lbank').eq('season_id', period)
    const t = v.length, wr = v.filter(r => r.win_rate != null).length, mdd = v.filter(r => r.max_drawdown != null).length
    console.log(`  ${period}: ${t} traders | WR: ${wr}/${t} (${Math.round(100*wr/t)}%) | MDD: ${mdd}/${t} (${Math.round(100*mdd/t)}%)`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
