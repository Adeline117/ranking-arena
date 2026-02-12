#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for KuCoin, BingX, Bitget Futures, Weex, Toobit
 * All periods (7D, 30D, 90D). NO fabricated data.
 * 
 * Usage:
 *   node scripts/import/enrich_lr_all5.mjs
 *   node scripts/import/enrich_lr_all5.mjs --source=kucoin
 */
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const sb = getSupabaseClient()
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

// ═══════════════════════════════════════════
// KuCoin — positionHistory + pnl/history APIs
// ═══════════════════════════════════════════
async function enrichKuCoin() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 KuCoin — all periods')
  console.log('═'.repeat(50))

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.kucoin.com/copy-trading',
    'Origin': 'https://www.kucoin.com',
  }
  const PERIOD_MAP = { '7D': '7d', '30D': '30d', '90D': '90d' }

  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'kucoin')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(3000)

  if (error || !rows?.length) { console.log('  ✅ Nothing to enrich'); return }

  // Group by trader+period
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.source_trader_id}|${r.season_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  console.log(`  📊 ${rows.length} rows, ${groups.size} trader-period combos`)

  let updated = 0, failed = 0
  const entries = [...groups.entries()]
  for (let i = 0; i < entries.length; i++) {
    const [key, rowList] = entries[i]
    const [traderId, seasonId] = key.split('|')
    const periodParam = PERIOD_MAP[seasonId] || '90d'

    if (i < 3 || (i + 1) % 50 === 0 || i === entries.length - 1)
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} failed=${failed}`)

    try {
      const [posResult, pnlResult] = await Promise.all([
        fetch(
          `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${traderId}&period=${periodParam}`,
          { headers: HEADERS, signal: AbortSignal.timeout(8000) }
        ).then(r => r.json()).catch(() => null),
        fetch(
          `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history?lang=en_US&leadConfigId=${traderId}&period=${periodParam}`,
          { headers: HEADERS, signal: AbortSignal.timeout(8000) }
        ).then(r => r.json()).catch(() => null),
      ])

      let winRate = null, tradesCount = null, maxDrawdown = null
      const posData = posResult?.data || []
      if (posData.length > 0) {
        const wins = posData.filter(p => parseFloat(p.closePnl) > 0).length
        winRate = parseFloat((wins / posData.length * 100).toFixed(2))
        tradesCount = posData.length
      }

      const pnlData = pnlResult?.data || []
      if (pnlData.length > 0) {
        // ratio is cumulative ROI (e.g. 0.11 = 11%)
        let peak = -Infinity, maxDD = 0
        const sorted = [...pnlData].sort((a, b) => (a.statTime || 0) - (b.statTime || 0))
        for (const d of sorted) {
          const ratio = parseFloat(d.ratio || 0)
          if (ratio > peak) peak = ratio
          const dd = peak - ratio
          if (dd > maxDD) maxDD = dd
        }
        if (maxDD > 0) maxDrawdown = parseFloat((maxDD * 100).toFixed(2))
      }

      for (const row of rowList) {
        const updates = {}
        if (row.win_rate == null && winRate != null) updates.win_rate = winRate
        if (row.max_drawdown == null && maxDrawdown != null) updates.max_drawdown = maxDrawdown
        if (row.trades_count == null && tradesCount != null) updates.trades_count = tradesCount
        if (!Object.keys(updates).length) continue
        const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!ue) updated++; else failed++
      }
      await sleep(150)
    } catch { failed++ }
  }
  console.log(`  ✅ KuCoin: ${updated} updated, ${failed} failed`)
}

// ═══════════════════════════════════════════
// BingX — recommend API + individual detail
// ═══════════════════════════════════════════
async function enrichBingX() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 BingX — all periods')
  console.log('═'.repeat(50))

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': 'https://bingx.com/',
    'Origin': 'https://bingx.com',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  // BingX timeType: 1=7d, 2=30d, 3=90d
  const PERIOD_MAP = { '7D': 1, '30D': 2, '90D': 3 }

  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'bingx')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(3000)

  if (error || !rows?.length) { console.log('  ✅ Nothing to enrich'); return }
  console.log(`  📊 ${rows.length} rows need enrichment`)

  // Try recommend API from bingx proxy
  const enrichMap = new Map() // key: traderId|seasonId

  // Try the qq-os recommend API (batch)
  for (const [period, timeType] of Object.entries(PERIOD_MAP)) {
    console.log(`  📋 Fetching ${period} via recommend API...`)
    for (let page = 0; page < 20; page++) {
      try {
        const r = await fetch(`https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${page}&pageSize=50`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ timeType }),
          signal: AbortSignal.timeout(10000),
        })
        const data = await r.json()
        if (data.code !== 0) break
        const items = data.data?.result || []
        if (!items.length) break
        for (const item of items) {
          const uid = String(item.trader?.uid || '')
          if (!uid) continue
          const stat = item.rankStat || {}
          enrichMap.set(`${uid}|${period}`, {
            tc: stat.totalTransactions ? parseInt(stat.totalTransactions) : null,
            wr: stat.winRate != null ? parseFloat(stat.winRate) : null,
            mdd: stat.maxDrawdown != null ? parseFloat(stat.maxDrawdown) : null,
          })
        }
        await sleep(500)
      } catch { break }
    }
  }
  console.log(`  recommend API: ${enrichMap.size} entries`)

  // Individual detail for remaining
  const remaining = rows.filter(r => !enrichMap.has(`${r.source_trader_id}|${r.season_id}`))
  console.log(`  Individual detail for ${remaining.length} remaining...`)
  for (let i = 0; i < remaining.length; i++) {
    const row = remaining[i]
    const timeType = PERIOD_MAP[row.season_id] || 3
    try {
      const r = await fetch(`https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/detail?uid=${row.source_trader_id}&timeType=${timeType}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000),
      })
      const data = await r.json()
      if (data.code === 0 && data.data) {
        const d = data.data
        enrichMap.set(`${row.source_trader_id}|${row.season_id}`, {
          wr: d.winRate != null ? parseFloat(d.winRate) : null,
          mdd: d.maxDrawdown != null ? parseFloat(d.maxDrawdown) : null,
          tc: d.totalTransactions != null ? parseInt(d.totalTransactions) : null,
        })
      }
    } catch {}
    if ((i + 1) % 20 === 0) console.log(`    [${i + 1}/${remaining.length}]`)
    await sleep(300)
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(`${row.source_trader_id}|${row.season_id}`)
    if (!d) continue
    const updates = {}
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.trades_count == null && d.tc != null) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
  }
  console.log(`  ✅ BingX: ${updated} updated`)
}

// ═══════════════════════════════════════════
// Bitget Futures — cycleData API
// ═══════════════════════════════════════════
async function enrichBitgetFutures() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Bitget Futures — all periods')
  console.log('═'.repeat(50))

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Content-Type': 'application/json',
    'Referer': 'https://www.bitget.com/',
    'Origin': 'https://www.bitget.com',
  }
  const PERIOD_MAP = { '7D': 7, '30D': 30, '90D': 90 }

  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'bitget_futures')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(3000)

  if (error || !rows?.length) { console.log('  ✅ Nothing to enrich'); return }
  console.log(`  📊 ${rows.length} rows need enrichment`)

  // Group by trader+period
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.source_trader_id}|${r.season_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  let updated = 0, blocked = 0, errors = 0
  const entries = [...groups.entries()]
  for (let i = 0; i < entries.length; i++) {
    const [key, rowList] = entries[i]
    const [traderId, seasonId] = key.split('|')
    const cycleTime = PERIOD_MAP[seasonId] || 90

    try {
      const r = await fetch('https://www.bitget.com/v1/trigger/trace/public/cycleData', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ languageType: 0, triggerUserId: traderId, cycleTime }),
        signal: AbortSignal.timeout(10000),
      })
      if (r.status === 403) { blocked++; if (blocked >= 5) { console.log(`  ⚠️ Too many blocks at ${i+1}`); break }; await sleep(2000); continue }
      const text = await r.text()
      if (text.includes('challenge') || text.includes('cloudflare')) { blocked++; if (blocked >= 5) break; await sleep(2000); continue }
      const result = JSON.parse(text)

      if (result.code === '00000' && result.data?.statisticsDTO) {
        const s = result.data.statisticsDTO
        for (const row of rowList) {
          const updates = {}
          if (row.win_rate == null && s.winningRate) updates.win_rate = parseFloat(s.winningRate)
          if (row.max_drawdown == null && s.maxRetracement) updates.max_drawdown = parseFloat(s.maxRetracement)
          if (row.trades_count == null && s.totalTrades) updates.trades_count = parseInt(s.totalTrades)
          if (!Object.keys(updates).length) continue
          const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
          if (!ue) updated++; else errors++
        }
        blocked = 0
      }
    } catch { errors++ }

    if ((i + 1) % 20 === 0 || i === entries.length - 1)
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} blocked=${blocked} errors=${errors}`)
    await sleep(800 + Math.random() * 500)
  }
  console.log(`  ✅ Bitget Futures: ${updated} updated, ${blocked} blocked, ${errors} errors`)
}

// ═══════════════════════════════════════════
// Weex — list + detail APIs
// ═══════════════════════════════════════════
async function enrichWeex() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Weex — all periods')
  console.log('═'.repeat(50))

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Referer': 'https://www.weex.com/',
    'Origin': 'https://www.weex.com',
  }
  const PERIOD_MAP = { '7D': 7, '30D': 30, '90D': 90 }

  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'weex')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(3000)

  if (error || !rows?.length) { console.log('  ✅ Nothing to enrich'); return }
  console.log(`  📊 ${rows.length} rows need enrichment`)

  const enrichMap = new Map()

  // Phase 1: List API for each period
  for (const [period, dataRange] of Object.entries(PERIOD_MAP)) {
    console.log(`  📋 List API ${period}...`)
    for (let page = 1; page <= 10; page++) {
      try {
        const r = await fetch('https://www.weex.com/gateway/v2/futures-copy-trade/public/traderListView', {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ pageNum: page, pageSize: 50, sortField: 'ROI', sortDirection: 'DESC', dataRange }),
          signal: AbortSignal.timeout(15000),
        })
        const data = await r.json()
        if (!data || data.code !== 'SUCCESS') break
        const items = data.data?.rows || []
        if (!items.length) break
        for (const item of items) {
          const id = String(item.traderUserId || '')
          if (!id) continue
          let wr = null, tc = null, mdd = null
          for (const col of (item.itemVoList || [])) {
            const desc = (col.showColumnDesc || '').toLowerCase()
            if (desc.includes('win rate') || desc.includes('胜率')) wr = parseFloat(col.showColumnValue)
            if (desc.includes('trades') || desc.includes('order') || desc.includes('交易')) tc = parseInt(col.showColumnValue)
            if (desc.includes('drawdown') || desc.includes('mdd') || desc.includes('回撤')) mdd = parseFloat(col.showColumnValue)
          }
          if (wr === null && item.winRate != null) wr = parseFloat(item.winRate)
          if (tc === null && item.totalOrderNum != null) tc = parseInt(item.totalOrderNum)
          if (mdd === null && item.maxDrawdown != null) mdd = parseFloat(item.maxDrawdown)
          enrichMap.set(`${id}|${period}`, { wr, tc, mdd })
        }
        await sleep(500)
      } catch { break }
    }
  }
  console.log(`  List: ${enrichMap.size} entries`)

  // Phase 2: Individual detail for remaining
  const remaining = rows.filter(r => !enrichMap.has(`${r.source_trader_id}|${r.season_id}`))
  console.log(`  Detail for ${remaining.length} remaining...`)
  for (let i = 0; i < remaining.length; i++) {
    const row = remaining[i]
    const dataRange = PERIOD_MAP[row.season_id] || 90
    try {
      const r = await fetch(`https://www.weex.com/gateway/v2/futures-copy-trade/public/traderDetailView?traderUserId=${row.source_trader_id}&dataRange=${dataRange}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
      })
      const d = await r.json()
      if (d?.code === 'SUCCESS' && d.data) {
        const dd = d.data
        enrichMap.set(`${row.source_trader_id}|${row.season_id}`, {
          wr: dd.winRate != null ? parseFloat(dd.winRate) : null,
          tc: dd.totalOrderNum != null ? parseInt(dd.totalOrderNum) : null,
          mdd: dd.maxDrawdown != null ? parseFloat(dd.maxDrawdown) : null,
        })
      }
    } catch {}
    if ((i + 1) % 10 === 0) console.log(`    [${i + 1}/${remaining.length}]`)
    await sleep(300)
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(`${row.source_trader_id}|${row.season_id}`)
    if (!d) continue
    const updates = {}
    if (row.win_rate == null && d.wr != null && !isNaN(d.wr)) updates.win_rate = d.wr
    if (row.max_drawdown == null && d.mdd != null && !isNaN(d.mdd)) updates.max_drawdown = d.mdd
    if (row.trades_count == null && d.tc != null && !isNaN(d.tc)) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
  }
  console.log(`  ✅ Weex: ${updated} updated`)
}

// ═══════════════════════════════════════════
// Toobit — leaders-new + leader-detail APIs
// ═══════════════════════════════════════════
async function enrichToobit() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Toobit — all periods')
  console.log('═'.repeat(50))

  const HEADERS = {
    'Origin': 'https://www.toobit.com',
    'Referer': 'https://www.toobit.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
  }
  const API = 'https://bapi.toobit.com/bapi/v1/copy-trading'
  const PERIOD_MAP = { '7D': 7, '30D': 30, '90D': 90 }

  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'toobit')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(3000)

  if (error || !rows?.length) { console.log('  ✅ Nothing to enrich'); return }
  console.log(`  📊 ${rows.length} rows need enrichment`)

  const enrichMap = new Map()

  // leaders-new API for each period
  for (const [period, dt] of Object.entries(PERIOD_MAP)) {
    console.log(`  📋 ${period}...`)
    for (let page = 1; page <= 10; page++) {
      try {
        const r = await fetch(`${API}/leaders-new?pageNo=${page}&pageSize=50&sortBy=roi&sortType=desc&dataType=${dt}`, {
          headers: HEADERS, signal: AbortSignal.timeout(10000)
        })
        const data = await r.json()
        if (data.code !== 200) break
        const items = data.data?.list || []
        if (!items.length) break
        for (const t of items) {
          const id = String(t.leaderUserId)
          let wr = t.leaderProfitOrderRatio != null ? parseFloat(t.leaderProfitOrderRatio) : null
          if (wr != null && wr >= 0 && wr <= 1) wr *= 100
          const tc = t.leaderTotalTradingNum != null ? parseInt(t.leaderTotalTradingNum)
            : t.leaderOrderCount != null ? parseInt(t.leaderOrderCount) : null
          let mdd = null
          const curve = t.leaderTradeProfit || []
          if (curve.length >= 2) {
            let peak = -Infinity, maxDD = 0
            for (const pt of curve) {
              const v = parseFloat(pt.value || 0)
              if (v > peak) peak = v
              if (peak - v > maxDD) maxDD = peak - v
            }
            if (maxDD > 0 && peak > 0) mdd = parseFloat((maxDD / (100 + peak) * 100).toFixed(2))
          }
          enrichMap.set(`${id}|${period}`, { wr, mdd, tc })
        }
        await sleep(300)
      } catch { break }
    }
  }
  console.log(`  leaders-new: ${enrichMap.size} entries`)

  // Individual detail for remaining
  const remaining = rows.filter(r => !enrichMap.has(`${r.source_trader_id}|${r.season_id}`))
  console.log(`  Detail for ${remaining.length} remaining...`)
  for (const row of remaining) {
    const dt = PERIOD_MAP[row.season_id] || 90
    try {
      const r = await fetch(`${API}/leader-detail?leaderUserId=${row.source_trader_id}&dataType=${dt}`, {
        headers: HEADERS, signal: AbortSignal.timeout(10000)
      })
      const d = await r.json()
      if (d?.code === 200 && d.data) {
        let wr = d.data.lastWeekWinRate != null ? parseFloat(d.data.lastWeekWinRate) : null
        if (wr != null && wr >= 0 && wr <= 1) wr *= 100
        const tc = d.data.totalOrderNum != null ? parseInt(d.data.totalOrderNum) : null
        enrichMap.set(`${row.source_trader_id}|${row.season_id}`, { wr, mdd: null, tc })
      }
    } catch {}
    await sleep(200)
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(`${row.source_trader_id}|${row.season_id}`)
    if (!d) continue
    const updates = {}
    if (row.win_rate == null && d.wr != null) updates.win_rate = Math.round(d.wr * 100) / 100
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.trades_count == null && d.tc != null) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
  }
  console.log(`  ✅ Toobit: ${updated} updated`)
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════
async function main() {
  console.log('🚀 Enriching leaderboard_ranks — 5 platforms, all periods')
  console.log(`   Time: ${new Date().toISOString()}`)
  console.log(`   Filter: ${SOURCE_FILTER || 'all'}`)

  const all = ['kucoin', 'bingx', 'bitget_futures', 'weex', 'toobit']
  const targets = SOURCE_FILTER ? [SOURCE_FILTER] : all

  for (const t of targets) {
    try {
      if (t === 'kucoin') await enrichKuCoin()
      else if (t === 'bingx') await enrichBingX()
      else if (t === 'bitget_futures') await enrichBitgetFutures()
      else if (t === 'weex') await enrichWeex()
      else if (t === 'toobit') await enrichToobit()
    } catch (e) { console.error(`❌ ${t}: ${e.message}`) }
  }

  // Verification
  console.log('\n═══ Final Verification ═══')
  for (const src of targets) {
    for (const period of ['7D', '30D', '90D']) {
      const { count: total } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src).eq('season_id', period)
      const { count: wr } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src).eq('season_id', period).not('win_rate', 'is', null)
      const { count: mdd } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src).eq('season_id', period).not('max_drawdown', 'is', null)
      const { count: tc } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src).eq('season_id', period).not('trades_count', 'is', null)
      if (total > 0) {
        console.log(`  ${src.padEnd(16)} ${period} total=${String(total).padStart(4)} wr=${String(wr).padStart(4)}(${String(Math.round(wr/total*100)).padStart(3)}%) mdd=${String(mdd).padStart(4)}(${String(Math.round(mdd/total*100)).padStart(3)}%) tc=${String(tc).padStart(4)}(${String(Math.round(tc/total*100)).padStart(3)}%)`)
      }
    }
  }
  console.log('\n✨ Done!')
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1) })
