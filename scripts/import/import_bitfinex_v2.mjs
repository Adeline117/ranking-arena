/**
 * Bitfinex Leaderboard 数据抓取 v2
 * 使用公开排行榜API: api-pub.bitfinex.com/v2/rankings
 * 竞赛类型: plu (盈亏), vol (交易量), plr (盈亏率)
 */
import { getSupabaseClient, sleep, getTargetPeriods } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bitfinex'

// 映射: 我们的周期 → Bitfinex竞赛key
const PERIOD_MAP = {
  '7D':  { key: 'plu:1w:tGLOBAL:USD', volKey: 'vol:1w:tGLOBAL:USD' },
  '30D': { key: 'plu_diff:1M:tGLOBAL:USD', volKey: 'vol:1M:tGLOBAL:USD', plrKey: 'plr:1M:tGLOBAL:USD' },
  '90D': { key: 'plu_diff:1M:tGLOBAL:USD', volKey: 'vol:1M:tGLOBAL:USD' }, // 90D用月度数据
}

async function fetchRanking(compKey, limit = 250) {
  const url = `https://api-pub.bitfinex.com/v2/rankings/${compKey}/hist?limit=${limit}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return []
    return await res.json()
  } catch (e) {
    console.log(`  ⚠ fetch failed: ${e.message}`)
    return []
  }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('Bitfinex 排行榜数据抓取 v2...')
  console.log(`周期: ${periods.join(', ')}`)

  for (const period of periods) {
    const config = PERIOD_MAP[period]
    if (!config) { console.log(`  ⚠ 未知周期: ${period}`); continue }

    console.log(`\n📋 抓取 ${period} (${config.key})...`)
    
    // Fetch PnL ranking
    const pnlData = await fetchRanking(config.key)
    console.log(`  盈亏排名: ${pnlData.length} 条`)

    // Fetch volume ranking for supplementary data
    let volMap = new Map()
    if (config.volKey) {
      const volData = await fetchRanking(config.volKey)
      for (const v of volData) {
        if (v[2]) volMap.set(v[2], v[6] || 0)
      }
      console.log(`  交易量数据: ${volData.length} 条`)
    }

    // Fetch PLR (profit/loss ratio) for win_rate proxy
    let plrMap = new Map()
    if (config.plrKey) {
      const plrData = await fetchRanking(config.plrKey)
      for (const p of plrData) {
        if (p[2]) plrMap.set(p[2], p[6] || 0)
      }
    }

    if (pnlData.length === 0) {
      console.log(`  ⚠ 无数据，跳过`)
      continue
    }

    const capturedAt = new Date().toISOString()
    
    // Upsert trader_sources
    const seenSrc = new Set()
    const traderSources = pnlData.filter(r => {
      const id = r[2] || `bitfinex_${pnlData.indexOf(r)}`
      if (seenSrc.has(id)) return false
      seenSrc.add(id)
      return true
    }).map((r, i) => ({
      source: SOURCE,
      source_trader_id: r[2] || `bitfinex_${i}`,
      handle: r[2] || null,
      avatar_url: null,
      last_refreshed_at: capturedAt,
    }))

    const { error: srcErr } = await supabase
      .from('trader_sources')
      .upsert(traderSources, { onConflict: 'source,source_trader_id' })
    if (srcErr) console.log(`  ⚠ trader_sources upsert: ${srcErr.message}`)
    else console.log(`  ✅ trader_sources: ${traderSources.length}`)

    // Upsert trader_snapshots (dedup by trader id)
    const seenSnap = new Set()
    const snapshots = pnlData.filter(r => {
      const id = r[2] || `bitfinex_${pnlData.indexOf(r)}`
      if (seenSnap.has(id)) return false
      seenSnap.add(id)
      return true
    }).map((r, i) => ({
      source: SOURCE,
      source_trader_id: r[2] || `bitfinex_${i}`,
      season_id: period,
      roi: null,
      pnl: r[6] || 0,
      win_rate: plrMap.get(r[2]) || null,
      max_drawdown: null,
      trades_count: null,
      followers: 0,
      captured_at: capturedAt,
    }))

    const { error: snapErr } = await supabase
      .from('trader_snapshots')
      .upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })
    if (snapErr) console.log(`  ⚠ snapshots upsert: ${snapErr.message}`)
    else console.log(`  ✅ snapshots: ${snapshots.length}`)

    await sleep(1000) // Rate limit
  }

  console.log('\n✅ Bitfinex v2 完成')
}

main()
