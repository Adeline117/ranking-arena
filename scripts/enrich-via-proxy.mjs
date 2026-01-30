#!/usr/bin/env node
/**
 * enrich-via-proxy.mjs — 通过 CF Worker 代理补齐各平台数据
 * 不需要 Playwright，纯 HTTP 请求
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const PROXY = 'https://ranking-arena-proxy.broosbook.workers.dev/proxy'
const DRY = process.argv.includes('--dry-run')
const SOURCE = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[%,]/g, ''))
  return isNaN(n) ? null : n
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function proxyFetch(url, opts = {}) {
  const encodedUrl = encodeURIComponent(url)
  const resp = await fetch(`${PROXY}?url=${encodedUrl}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body,
  })
  return resp.json()
}

// ═══════════════════════════════════════════
// Bitget — topTraders + viewDataVO
// ═══════════════════════════════════════════
async function enrichBitget() {
  console.log('\n═══ Bitget ═══')

  const { data: snaps } = await sb
    .from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'bitget_futures')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
  if (!snaps?.length) { console.log('✅ Nothing to enrich'); return }

  const traderMap = new Map()
  for (const s of snaps) {
    if (!traderMap.has(s.source_trader_id)) traderMap.set(s.source_trader_id, [])
    traderMap.get(s.source_trader_id).push(s)
  }
  console.log(`📊 ${snaps.length} snapshots, ${traderMap.size} traders missing data`)

  // Get all traders from topTraders
  const resp = await proxyFetch('https://www.bitget.com/v1/trigger/trace/public/topTraders', {
    method: 'POST',
    body: JSON.stringify({ pageNo: 1, pageSize: 50, model: 1 })
  })
  const categories = resp?.data?.rows || []
  const traders = new Map()
  for (const cat of categories) {
    for (const t of (cat.showColumnValue || [])) {
      const uid = t.traderUid
      if (!uid) continue
      const vd = t.viewDataVO || {}
      const items = t.itemVoList || []
      const metrics = {
        pnl: parseNum(vd.totalProfit),
        win_rate: null,
        max_drawdown: null,
        trades_count: null,
      }
      for (const item of items) {
        if (item.showColumnCode === 'total_winning_rate') metrics.win_rate = parseNum(item.comparedValue)
        if (item.showColumnCode === 'max_retracement') metrics.max_drawdown = parseNum(item.comparedValue)
      }
      traders.set(uid, metrics)
    }
  }
  console.log(`📋 Got ${traders.size} traders from API`)

  let updated = 0, matched = 0
  for (const [uid, rows] of traderMap) {
    const metrics = traders.get(uid)
    if (!metrics) continue
    matched++
    for (const snap of rows) {
      const updates = {}
      if (snap.pnl == null && metrics.pnl != null) updates.pnl = metrics.pnl
      if (snap.win_rate == null && metrics.win_rate != null) updates.win_rate = metrics.win_rate
      if (snap.max_drawdown == null && metrics.max_drawdown != null) updates.max_drawdown = metrics.max_drawdown
      if (snap.trades_count == null && metrics.trades_count != null) updates.trades_count = metrics.trades_count
      if (!Object.keys(updates).length) continue
      if (!DRY) {
        const { error } = await sb.from('trader_snapshots').update(updates).eq('id', snap.id)
        if (!error) updated++
      } else {
        console.log(`  [DRY] ${snap.id} → ${JSON.stringify(updates)}`)
        updated++
      }
    }
  }
  console.log(`✅ Bitget: matched ${matched}/${traderMap.size}, updated ${updated} snapshots`)
}

// ═══════════════════════════════════════════
// MEXC — 尝试新 API 端点
// ═══════════════════════════════════════════
async function enrichMEXC() {
  console.log('\n═══ MEXC ═══')

  // Try multiple possible API endpoints
  const endpoints = [
    { url: 'https://futures.mexc.com/api/v1/copytrading/trader/ranking', method: 'GET' },
    { url: 'https://contract.mexc.com/api/v1/private/copytrading/trader/list', method: 'GET' },
    { url: 'https://www.mexc.com/api/v1/copytrading/trader/list?page=1&size=5', method: 'GET' },
    { url: 'https://www.mexc.com/api/platform/copy-trade/v2/trader/list', method: 'POST', body: JSON.stringify({page:1,size:5}) },
  ]
  
  for (const ep of endpoints) {
    try {
      const resp = await proxyFetch(ep.url, { method: ep.method, body: ep.body })
      const status = resp?.code || resp?.status || resp?.success
      console.log(`  ${ep.url.split('/').slice(-2).join('/')} → code: ${status}`)
      if (resp?.data) {
        console.log(`  Data keys: ${Object.keys(resp.data).join(', ')}`)
        return // Found working endpoint
      }
    } catch (e) {
      console.log(`  ${ep.url.split('/').pop()} → error`)
    }
  }
  console.log('  ⚠ No working MEXC API found')
}

// ═══════════════════════════════════════════
// Bybit — 尝试新 API
// ═══════════════════════════════════════════
async function enrichBybit() {
  console.log('\n═══ Bybit ═══')

  const endpoints = [
    { url: 'https://api2.bybit.com/fapi/beehive/public/v2/common/leader/list', method: 'POST', body: JSON.stringify({pageNo:1,pageSize:3,timeRange:"QUARTER"}) },
    { url: 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-list', method: 'POST', body: JSON.stringify({pageNo:1,pageSize:3,timeRange:"90"}) },
    { url: 'https://www.bybit.com/bycsi-api/user/open-api/leader/list', method: 'POST', body: JSON.stringify({pageNo:1,pageSize:3}) },
  ]

  for (const ep of endpoints) {
    try {
      const resp = await proxyFetch(ep.url, { method: ep.method, body: ep.body })
      console.log(`  ${ep.url.split('/').slice(-2).join('/')} → ${JSON.stringify(resp).substring(0, 200)}`)
      if (resp?.result?.leaderDetails || resp?.data) {
        console.log('  ✅ Found working endpoint!')
        return
      }
    } catch (e) {
      console.log(`  error: ${e.message}`)
    }
  }
  console.log('  ⚠ No working Bybit API found')
}

// ═══════════════════════════════════════════
// CoinEx
// ═══════════════════════════════════════════
async function enrichCoinEx() {
  console.log('\n═══ CoinEx ═══')

  const endpoints = [
    'https://www.coinex.com/res/copy-trading/traders?limit=3&offset=0',
    'https://www.coinex.com/res/copy-trading/v1/traders?limit=3',
    'https://www.coinex.com/res/copy/v1/leader/list?limit=3',
    'https://api.coinex.com/v2/copy-trading/traders?limit=3',
  ]

  for (const url of endpoints) {
    try {
      const resp = await proxyFetch(url)
      console.log(`  ${url.split('/').slice(-2).join('/').split('?')[0]} → ${JSON.stringify(resp).substring(0, 200)}`)
      if (resp?.data && !resp?.error) {
        console.log('  ✅ Found working endpoint!')
        return
      }
    } catch (e) {
      console.log(`  error`)
    }
  }
  console.log('  ⚠ No working CoinEx API found')
}

// ═══════════════════════════════════════════
async function main() {
  console.log(`🤖 Proxy Enrichment ${DRY ? '[DRY RUN]' : ''}`)

  const platforms = SOURCE ? [SOURCE] : ['bitget_futures', 'mexc', 'bybit', 'coinex']
  for (const p of platforms) {
    if (p === 'bitget_futures') await enrichBitget()
    else if (p === 'mexc') await enrichMEXC()
    else if (p === 'bybit') await enrichBybit()
    else if (p === 'coinex') await enrichCoinEx()
  }

  // Final stats
  console.log('\n═══ Current Coverage ═══')
  for (const src of ['kucoin', 'mexc', 'coinex', 'bitget_futures', 'bybit']) {
    const { count: total } = await sb.from('trader_snapshots').select('id', { count: 'exact', head: true }).eq('source', src)
    const gaps = {}
    for (const f of ['pnl', 'win_rate', 'max_drawdown', 'trades_count']) {
      const { count } = await sb.from('trader_snapshots').select('id', { count: 'exact', head: true }).eq('source', src).not(f, 'is', null)
      gaps[f] = Math.round(count / total * 100)
    }
    console.log(`${src.padEnd(18)} pnl:${gaps.pnl}% wr:${gaps.win_rate}% dd:${gaps.max_drawdown}% tc:${gaps.trades_count}%`)
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
