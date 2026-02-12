#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for KuCoin, Weex, Toobit
 * Fills: win_rate, max_drawdown, trades_count
 * Only uses real API data — NO fabricated values.
 *
 * Usage:
 *   node scripts/enrich-leaderboard-ranks.mjs                # all 3
 *   node scripts/enrich-leaderboard-ranks.mjs --source=kucoin
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ═══════════════════════════════════════════
// KuCoin — direct HTTP to internal API
// ═══════════════════════════════════════════
async function enrichKuCoin() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 KuCoin — enriching leaderboard_ranks')
  console.log('═'.repeat(50))

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.kucoin.com/copy-trading',
    'Origin': 'https://www.kucoin.com',
  }

  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'kucoin')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(2000)

  if (error || !rows?.length) {
    console.log('  ✅ Nothing to enrich', error?.message || '')
    return
  }

  // Group by trader+season
  const groupMap = new Map()
  for (const r of rows) {
    const key = `${r.source_trader_id}|${r.season_id}`
    if (!groupMap.has(key)) groupMap.set(key, [])
    groupMap.get(key).push(r)
  }
  console.log(`  📊 ${rows.length} rows, ${groupMap.size} trader-period combos`)

  let updated = 0, failed = 0, apiErrors = 0
  const entries = [...groupMap.entries()]

  for (let i = 0; i < entries.length; i++) {
    const [key, rowList] = entries[i]
    const [traderId, seasonId] = key.split('|')
    const periodParam = seasonId === '7D' ? '7d' : seasonId === '30D' ? '30d' : '90d'

    if (i < 5 || (i + 1) % 50 === 0) console.log(`  [${i + 1}/${entries.length}] trader=${traderId} period=${periodParam} updated=${updated} failed=${failed}`)

    try {
      let winRate = null, tradesCount = null, maxDrawdown = null

      // Fetch both APIs in parallel
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

      const posData = posResult?.data || []
      if (posData.length > 0) {
        const wins = posData.filter(p => parseFloat(p.closePnl) > 0).length
        winRate = parseFloat((wins / posData.length * 100).toFixed(2))
        tradesCount = posData.length
      }

      const pnlData = pnlResult?.data || []
      if (pnlData.length > 0) {
        let peak = -Infinity, maxDD = 0
        for (const d of pnlData) {
          const ratio = parseFloat(d.ratio || 0)
          if (ratio > peak) peak = ratio
          const dd = peak - ratio
          if (dd > maxDD) maxDD = dd
        }
        maxDrawdown = parseFloat((maxDD * 100).toFixed(2))
      }

      for (const row of rowList) {
        const updates = {}
        if (row.win_rate == null && winRate != null) updates.win_rate = winRate
        if (row.max_drawdown == null && maxDrawdown != null) updates.max_drawdown = maxDrawdown
        if (row.trades_count == null && tradesCount != null) updates.trades_count = tradesCount
        if (!Object.keys(updates).length) continue

        const { error: ue } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!ue) updated++
        else failed++
      }

      await sleep(150)
    } catch (e) {
      failed++
      if (i < 5) console.log(`    ❌ ${traderId}: ${e.message}`)
    }
  }

  console.log(`  ✅ KuCoin: ${updated} updated, ${failed} failed, ${apiErrors} API errors`)
}

// ═══════════════════════════════════════════
// Toobit — uses leaders-new list API
// Available fields:
//   - leaderProfitOrderRatio → win_rate
//   - leaderOrderCount → trades_count
//   - leaderTradeProfit curve → max_drawdown (computed)
// ═══════════════════════════════════════════
async function enrichToobit() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Toobit — enriching leaderboard_ranks')
  console.log('═'.repeat(50))

  const HEADERS = {
    'Origin': 'https://www.toobit.com',
    'Referer': 'https://www.toobit.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
  }
  const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
  const PERIOD_MAP = { '7D': 7, '30D': 30, '90D': 90 }

  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'toobit')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(2000)

  if (error || !rows?.length) {
    console.log('  ✅ Nothing to enrich', error?.message || '')
    return
  }

  console.log(`  📊 ${rows.length} rows to enrich`)

  // Cache: traderId|period → {wr, tc, mdd}
  const cache = new Map()

  for (const [period, dt] of Object.entries(PERIOD_MAP)) {
    console.log(`  📋 Fetching ${period} leaderboard...`)
    let prevCacheSize = cache.size
    for (let page = 1; page <= 10; page++) {
      try {
        const res = await fetch(`${API_BASE}/leaders-new?pageNo=${page}&pageSize=50&sortBy=roi&sortType=desc&dataType=${dt}`, {
          headers: HEADERS, signal: AbortSignal.timeout(10000)
        })
        const json = await res.json()
        const list = json?.data?.list || []
        if (!list.length) break

        for (const t of list) {
          const id = String(t.leaderUserId)
          let wr = t.leaderProfitOrderRatio != null ? parseFloat(t.leaderProfitOrderRatio) : null
          if (wr != null && wr <= 1) wr *= 100
          const tc = t.leaderOrderCount != null ? parseInt(t.leaderOrderCount) : null

          // Compute MDD from profit curve
          let mdd = null
          const curve = t.leaderTradeProfit || []
          if (curve.length > 0) {
            let peak = -Infinity, maxDD = 0
            for (const pt of curve) {
              const v = parseFloat(pt.value || 0)
              if (v > peak) peak = v
              const dd = peak - v
              if (dd > maxDD) maxDD = dd
            }
            mdd = parseFloat((maxDD * 100).toFixed(2))
          }

          cache.set(`${id}|${period}`, { wr, tc, mdd })
        }
        await sleep(200)
        // Stop if no new traders
        if (cache.size === prevCacheSize && page > 2) break
        prevCacheSize = cache.size
      } catch (e) {
        console.log(`    page ${page} error: ${e.message}`)
        break
      }
    }
  }
  console.log(`  📋 Cached ${cache.size} trader-period entries`)

  // Update DB
  let updated = 0, failed = 0, skipped = 0
  for (const row of rows) {
    const key = `${row.source_trader_id}|${row.season_id}`
    const data = cache.get(key)
    if (!data) { skipped++; continue }

    const updates = {}
    if (row.win_rate == null && data.wr != null) updates.win_rate = data.wr
    if (row.max_drawdown == null && data.mdd != null) updates.max_drawdown = data.mdd
    if (row.trades_count == null && data.tc != null) updates.trades_count = data.tc
    if (!Object.keys(updates).length) continue

    const { error: ue } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
    else failed++
  }

  console.log(`  ✅ Toobit: ${updated} updated, ${failed} failed, ${skipped} not in API`)
}

// ═══════════════════════════════════════════
// Weex — try Playwright with API interception
// ═══════════════════════════════════════════
async function enrichWeex() {
  console.log('\n' + '═'.repeat(50))
  console.log('🔄 Weex — enriching leaderboard_ranks')
  console.log('═'.repeat(50))

  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'weex')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(2000)

  if (error || !rows?.length) {
    console.log('  ✅ Nothing to enrich', error?.message || '')
    return
  }

  const traderIds = [...new Set(rows.map(r => r.source_trader_id))]
  console.log(`  📊 ${rows.length} rows, ${traderIds.length} unique traders`)

  // Try direct API endpoints first
  const WEEX_HEADERS = {
    'Origin': 'https://www.weex.com',
    'Referer': 'https://www.weex.com/zh-CN/copy-trading',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }

  // Try to discover Weex API
  const testId = traderIds[0]
  console.log(`  🔍 Testing Weex APIs with trader ${testId}...`)

  const endpoints = [
    `https://www.weex.com/api/v1/copy-trading/trader/detail?traderUid=${testId}`,
    `https://capi.weex.com/api/v1/copy-trading/trader/detail?traderUid=${testId}`,
    `https://www.weex.com/ucenter/api/v1/copy-trading/trader/detail?traderUid=${testId}`,
    `https://api.weex.com/api/v1/copy-trading/trader/${testId}`,
    `https://www.weex.com/api/copy-trade/v1/trader/info?uid=${testId}`,
  ]

  let workingEndpoint = null
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, { headers: WEEX_HEADERS, signal: AbortSignal.timeout(8000) })
      const json = await res.json()
      const short = ep.split('weex.com')[1]?.split('?')[0] || ep
      console.log(`    ${short}: ${res.status} keys=${json.data ? Object.keys(json.data).slice(0,5).join(',') : 'no data'}`)
      if (res.ok && json.data && (json.data.winRate != null || json.data.winRatio != null || json.data.tradeCount != null)) {
        workingEndpoint = ep.replace(testId, '__ID__')
        console.log(`    ✅ Found working endpoint!`)
        break
      }
    } catch (e) {
      console.log(`    ${ep.split('?')[0].split('/').slice(-2).join('/')}: ${e.message}`)
    }
  }

  if (!workingEndpoint) {
    console.log('  ⚠️ No working Weex API found. Trying Playwright scraping...')
    
    // Try Playwright
    let chromium
    try {
      chromium = (await import('playwright')).chromium
    } catch {
      console.log('  ❌ Playwright not available')
      return
    }

    const browser = await chromium.launch({
      headless: true,
      args: ['--proxy-server=http://127.0.0.1:7890'],
    })
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    })
    const page = await ctx.newPage()

    console.log('  🌐 Loading Weex...')
    try {
      await page.goto('https://www.weex.com/zh-CN/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(5000)
    } catch (e) {
      console.log(`  ❌ Cannot load Weex: ${e.message}`)
      await browser.close()
      return
    }

    let updated = 0, failed = 0
    for (let i = 0; i < traderIds.length; i++) {
      const traderId = traderIds[i]
      if (i === 0 || (i + 1) % 10 === 0) console.log(`  [${i + 1}/${traderIds.length}] updated=${updated}`)

      try {
        // Intercept API
        const apiData = {}
        const handler = async (response) => {
          if (response.status() !== 200) return
          try {
            const ct = response.headers()['content-type'] || ''
            if (!ct.includes('json')) return
            const body = await response.json().catch(() => null)
            if (!body?.data) return
            const d = body.data
            if (d.winRate != null) apiData.winRate = parseFloat(d.winRate)
            if (d.winRatio != null) apiData.winRate = parseFloat(d.winRatio)
            if (d.maxDrawdown != null) apiData.maxDrawdown = Math.abs(parseFloat(d.maxDrawdown))
            if (d.totalTrades != null) apiData.tradesCount = parseInt(d.totalTrades)
            if (d.tradeCount != null) apiData.tradesCount = parseInt(d.tradeCount)
            if (d.orderCount != null) apiData.tradesCount = parseInt(d.orderCount)
          } catch {}
        }
        page.on('response', handler)

        await page.goto(`https://www.weex.com/zh-CN/copy-trading/trader/${traderId}`, {
          waitUntil: 'domcontentloaded', timeout: 20000
        }).catch(() => {})
        await sleep(4000)
        page.off('response', handler)

        // DOM scraping fallback
        const domData = await page.evaluate(() => {
          const text = document.body.innerText
          const result = {}
          const wrMatch = text.match(/(?:Win Rate|胜率|Win ratio)[:\s]*(\d+\.?\d*)\s*%/i)
          if (wrMatch) result.winRate = parseFloat(wrMatch[1])
          const mddMatch = text.match(/(?:Max\.? ?Drawdown|MDD|最大回撤)[:\s]*(-?\d+\.?\d*)\s*%/i)
          if (mddMatch) result.maxDrawdown = Math.abs(parseFloat(mddMatch[1]))
          const tcMatch = text.match(/(?:Total Trades|交易次数|Trades|订单数|交易笔数)[:\s]*([\d,]+)/i)
          if (tcMatch) result.tradesCount = parseInt(tcMatch[1].replace(/,/g, ''))
          return result
        }).catch(() => ({}))

        const merged = { ...domData, ...apiData }
        let wr = merged.winRate
        if (wr != null && wr > 0 && wr <= 1) wr *= 100
        let mdd = merged.maxDrawdown
        if (mdd != null && mdd > 0 && mdd <= 1) mdd *= 100
        const tc = merged.tradesCount

        const traderRows = rows.filter(r => r.source_trader_id === traderId)
        for (const row of traderRows) {
          const updates = {}
          if (row.win_rate == null && wr != null) updates.win_rate = wr
          if (row.max_drawdown == null && mdd != null) updates.max_drawdown = mdd
          if (row.trades_count == null && tc != null) updates.trades_count = tc
          if (!Object.keys(updates).length) continue
          const { error: ue } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
          if (!ue) updated++
          else failed++
        }

        await sleep(Math.floor(Math.random() * 2000) + 1000)
      } catch { failed++ }
    }

    await browser.close()
    console.log(`  ✅ Weex (Playwright): ${updated} updated, ${failed} failed`)
    return
  }

  // Use working API endpoint
  let updated = 0, failed = 0
  for (let i = 0; i < traderIds.length; i++) {
    const traderId = traderIds[i]
    if (i === 0 || (i + 1) % 20 === 0) console.log(`  [${i + 1}/${traderIds.length}] updated=${updated}`)

    try {
      const url = workingEndpoint.replace('__ID__', traderId)
      const res = await fetch(url, { headers: WEEX_HEADERS, signal: AbortSignal.timeout(8000) })
      const json = await res.json()
      const d = json.data
      if (!d) { failed++; continue }

      let wr = d.winRate ?? d.winRatio ?? null
      if (wr != null) { wr = parseFloat(wr); if (wr > 0 && wr <= 1) wr *= 100 }
      let mdd = d.maxDrawdown != null ? Math.abs(parseFloat(d.maxDrawdown)) : null
      if (mdd != null && mdd > 0 && mdd <= 1) mdd *= 100
      let tc = d.totalTrades ?? d.tradeCount ?? d.orderCount ?? null
      if (tc != null) tc = parseInt(tc)

      const traderRows = rows.filter(r => r.source_trader_id === traderId)
      for (const row of traderRows) {
        const updates = {}
        if (row.win_rate == null && wr != null) updates.win_rate = wr
        if (row.max_drawdown == null && mdd != null) updates.max_drawdown = mdd
        if (row.trades_count == null && tc != null) updates.trades_count = tc
        if (!Object.keys(updates).length) continue
        const { error: ue } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!ue) updated++
        else failed++
      }
      await sleep(300)
    } catch { failed++ }
  }

  console.log(`  ✅ Weex: ${updated} updated, ${failed} failed`)
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════
async function main() {
  console.log('🚀 Enriching leaderboard_ranks')
  console.log(`   Time: ${new Date().toISOString()}`)
  console.log(`   Filter: ${SOURCE_FILTER || 'all'}`)

  const targets = SOURCE_FILTER ? [SOURCE_FILTER] : ['toobit', 'kucoin', 'weex']

  for (const t of targets) {
    try {
      if (t === 'kucoin') await enrichKuCoin()
      else if (t === 'toobit') await enrichToobit()
      else if (t === 'weex') await enrichWeex()
    } catch (e) {
      console.log(`❌ ${t}: ${e.message}`)
    }
  }

  // Verify
  console.log('\n═══ Verification ═══')
  for (const src of ['kucoin', 'weex', 'toobit']) {
    const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src)
    const { count: wr } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src).not('win_rate', 'is', null)
    const { count: mdd } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src).not('max_drawdown', 'is', null)
    const { count: tc } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', src).not('trades_count', 'is', null)
    console.log(`  ${src.padEnd(10)} total=${total} wr=${wr}(${total ? Math.round(wr/total*100) : 0}%) mdd=${mdd}(${total ? Math.round(mdd/total*100) : 0}%) tc=${tc}(${total ? Math.round(tc/total*100) : 0}%)`)
  }

  console.log('\n✨ Done!')
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1) })
