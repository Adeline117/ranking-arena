import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function deriveForPlatform(platform: string) {
  const { data: missing } = await s.from('leaderboard_ranks')
    .select('source_trader_id, win_rate, max_drawdown, season_id')
    .eq('source', platform)
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(10000)

  if (!missing?.length) { console.log(`${platform}: 0 missing`); return 0 }

  const traderMap = new Map<string, typeof missing>()
  for (const row of missing) {
    const key = row.source_trader_id
    if (!traderMap.has(key)) traderMap.set(key, [])
    traderMap.get(key)!.push(row)
  }
  console.log(`${platform}: ${traderMap.size} traders (${missing.length} rows)`)

  let derived = 0
  const batch = [...traderMap.entries()]

  for (const [traderId, rows] of batch) {
    const { data: v2snaps } = await s.from('trader_snapshots_v2')
      .select('roi_pct, created_at')
      .eq('platform', platform).eq('trader_key', traderId)
      .not('roi_pct', 'is', null)
      .order('created_at', { ascending: true }).limit(200)

    let snapshots = (v2snaps || []).map((r: Record<string, unknown>) => ({ roi: r.roi_pct as number, ts: r.created_at as string }))

    if (snapshots.length < 3) {
      const { data: v1 } = await s.from('trader_snapshots')
        .select('roi, captured_at')
        .eq('source', platform).eq('source_trader_id', traderId)
        .not('roi', 'is', null)
        .order('captured_at', { ascending: true }).limit(200)
      if (v1 && v1.length > snapshots.length)
        snapshots = v1.map((r: Record<string, unknown>) => ({ roi: r.roi as number, ts: r.captured_at as string }))
    }

    if (snapshots.length < 2) continue

    const daily = new Map<string, number>()
    for (const snap of snapshots) {
      const day = snap.ts?.slice(0, 10)
      if (day && snap.roi != null) daily.set(day, snap.roi)
    }
    const rois = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1])
    if (rois.length < 2) continue

    let wins = 0, days = 0
    for (let i = 1; i < rois.length; i++) { if (rois[i] > rois[i-1]) wins++; days++ }
    const wr = days > 0 ? parseFloat(((wins/days)*100).toFixed(2)) : null

    const eq = rois.map(r => 1 + r/100)
    let peak = eq[0], maxDD = 0
    for (const e of eq) { if (e > peak) peak = e; const dd = peak > 0 ? (peak-e)/peak : 0; if (dd > maxDD) maxDD = dd }
    const mdd = parseFloat((maxDD * 100).toFixed(2))

    for (const row of rows) {
      const upd: Record<string, number> = {}
      if (row.win_rate == null && wr != null) upd.win_rate = wr
      if (row.max_drawdown == null && mdd > 0) upd.max_drawdown = mdd
      if (Object.keys(upd).length > 0) {
        await s.from('leaderboard_ranks').update(upd)
          .eq('source', platform).eq('source_trader_id', traderId).eq('season_id', row.season_id)
        derived++
      }
    }
  }
  console.log(`${platform}: derived ${derived} rows`)
  return derived
}

async function main() {
  const platforms = [
    'drift','bitfinex','binance_spot','hyperliquid','bitunix','aevo','dydx','gmx',
    'jupiter_perps','gains','etoro','coinex','btcc','toobit','phemex','lbank','blofin',
    'binance_futures','bybit','okx_futures','mexc','gateio','bingx','htx_futures',
    'okx_web3','binance_web3','web3_bot','kucoin','xt','bybit_spot','bitget_spot','weex','bitget_futures'
  ]
  let total = 0
  for (const p of platforms) { total += await deriveForPlatform(p) }

  const { count: t } = await s.from('leaderboard_ranks').select('*', { count: 'exact', head: true })
  const { count: wr } = await s.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).not('win_rate', 'is', null)
  const { count: mdd } = await s.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).not('max_drawdown', 'is', null)
  console.log(`\nFINAL: WR=${(100*wr!/t!).toFixed(1)}% (${wr}/${t}) | MDD=${(100*mdd!/t!).toFixed(1)}% (${mdd}/${t}) | Derived=${total}`)
}
main().catch(console.error)
