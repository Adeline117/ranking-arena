/**
 * 通过 Cloudflare Worker 代理补充缺失数据
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Load .env.local manually
try {
  const envLocal = readFileSync('.env.local', 'utf8')
  for (const line of envLocal.split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function proxyFetch(url, opts = {}) {
  const proxyUrl = `${PROXY}/proxy?url=${encodeURIComponent(url)}`
  const res = await fetch(proxyUrl, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    signal: AbortSignal.timeout(12000),
  })
  return res.json()
}

// ============================================
// Bitget - via /v1/trigger/trace/queryTraderDetail
// ============================================
async function enrichBitget() {
  console.log('\n📊 Bitget Futures - enrichment via proxy...')
  const { data: snaps } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'bitget_futures')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null')
    .limit(500)

  console.log(`  缺失: ${snaps?.length || 0}`)
  if (!snaps?.length) return

  let ok = 0, fail = 0
  for (const snap of snaps) {
    try {
      const data = await proxyFetch('https://www.bitget.com/v1/trigger/trace/queryTraderDetail', {
        method: 'POST',
        body: JSON.stringify({ traderId: snap.source_trader_id, languageType: 0 }),
      })
      const r = data?.data
      if (!r) { fail++; continue }

      const updates = {}
      if (snap.pnl == null && r.totalProfit != null) updates.pnl = parseFloat(r.totalProfit)
      if (snap.win_rate == null && r.winRate != null) updates.win_rate = parseFloat(r.winRate) * 100
      if (snap.max_drawdown == null && r.maxDrawDown != null) updates.max_drawdown = parseFloat(r.maxDrawDown) * 100
      if (snap.trades_count == null && r.totalOrderNum != null) updates.trades_count = parseInt(r.totalOrderNum)

      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        ok++
      }
      if (ok % 50 === 0 && ok > 0) console.log(`  进度: ${ok}/${snaps.length}`)
      await sleep(250)
    } catch (e) { fail++ }
  }
  console.log(`  ✅ 补充 ${ok} / 失败 ${fail}`)
}

// ============================================
// Binance Futures - via proxy copy-trading list API
// ============================================
async function refreshBinance() {
  console.log('\n📊 Binance Futures - 刷新排行榜 via proxy...')
  const periods = [
    { apiPeriod: '30D', seasonId: 'current_30d' },
    { apiPeriod: '90D', seasonId: 'current_90d' },
  ]

  for (const { apiPeriod, seasonId } of periods) {
    let total = 0
    for (let page = 1; page <= 25; page++) {
      try {
        const data = await proxyFetch('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list', {
          method: 'POST',
          body: JSON.stringify({
            pageNumber: page, pageSize: 20, timeRange: apiPeriod,
            dataType: 'ROI', favoriteOnly: false,
          }),
        })

        const list = data?.data?.list
        if (!list?.length) break

        for (const item of list) {
          const tid = item.leadPortfolioId || item.portfolioId || item.encryptedUid
          if (!tid) continue
          await supabase.from('trader_snapshots').upsert({
            source: 'binance_futures',
            source_trader_id: tid,
            season_id: seasonId,
            roi: item.roi != null ? parseFloat(item.roi) * 100 : null,
            pnl: item.pnl != null ? parseFloat(item.pnl) : null,
            win_rate: item.winRate != null ? parseFloat(item.winRate) * 100 : null,
            max_drawdown: item.maxDrawdown != null ? parseFloat(item.maxDrawdown) * 100 : null,
            trades_count: item.tradeCount || null,
            follower_count: item.copierNum || null,
            captured_at: new Date().toISOString(),
          }, { onConflict: 'source,source_trader_id,season_id' })
          total++
        }
        await sleep(500)
      } catch (e) {
        console.log(`  ⚠ ${apiPeriod} p${page}: ${e.message}`)
        break
      }
    }
    console.log(`  ${apiPeriod}: ${total} 条`)
  }
}

// ============================================
// Binance Spot - via proxy
// ============================================
async function refreshBinanceSpot() {
  console.log('\n📊 Binance Spot - 刷新 via proxy...')
  let total = 0
  for (let page = 1; page <= 25; page++) {
    try {
      const data = await proxyFetch('https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list', {
        method: 'POST',
        body: JSON.stringify({
          pageNumber: page, pageSize: 20, timeRange: '90D',
          dataType: 'ROI', favoriteOnly: false,
        }),
      })
      const list = data?.data?.list
      if (!list?.length) break
      for (const item of list) {
        const tid = item.leadPortfolioId || item.portfolioId || item.encryptedUid
        if (!tid) continue
        await supabase.from('trader_snapshots').upsert({
          source: 'binance_spot',
          source_trader_id: tid,
          season_id: 'current_90d',
          roi: item.roi != null ? parseFloat(item.roi) * 100 : null,
          pnl: item.pnl != null ? parseFloat(item.pnl) : null,
          win_rate: item.winRate != null ? parseFloat(item.winRate) * 100 : null,
          captured_at: new Date().toISOString(),
        }, { onConflict: 'source,source_trader_id,season_id' })
        total++
      }
      await sleep(500)
    } catch (e) {
      console.log(`  ⚠ p${page}: ${e.message}`)
      break
    }
  }
  console.log(`  ✅ ${total} 条`)
}

// ============================================
// Main
// ============================================
async function main() {
  console.log('🚀 CF Proxy Enrichment')
  console.log(`Proxy: ${PROXY}`)

  await refreshBinance()
  await refreshBinanceSpot()
  await enrichBitget()

  console.log('\n✅ Done!')
}

main().catch(console.error)
