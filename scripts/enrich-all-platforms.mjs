/**
 * 全平台数据补充脚本
 * 
 * 通过各交易所公开API补充缺失的snapshot字段
 * 纯API调用，不需要浏览器
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url, options = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    ...options.headers
  }
  
  // Try direct first, then proxy
  try {
    const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(10000) })
    if (res.ok) return await res.json()
    if (res.status === 451 && PROXY_URL) {
      // Try via proxy
      const proxyRes = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
        ...options, headers, signal: AbortSignal.timeout(10000)
      })
      if (proxyRes.ok) return await proxyRes.json()
    }
    return null
  } catch (e) {
    // Try proxy as fallback
    if (PROXY_URL) {
      try {
        const proxyRes = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`, {
          ...options, headers, signal: AbortSignal.timeout(10000)
        })
        if (proxyRes.ok) return await proxyRes.json()
      } catch {}
    }
    return null
  }
}

// ============================================
// Bybit enrichment
// ============================================
async function enrichBybit() {
  console.log('\n📊 Bybit - 补充缺失字段...')
  const { data: snaps } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'bybit')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null')
    .limit(500)
  
  console.log(`  需要补充: ${snaps?.length || 0} 条`)
  if (!snaps?.length) return
  
  let updated = 0
  for (const snap of snaps) {
    try {
      const data = await fetchJSON(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-detail?leaderId=${snap.source_trader_id}`)
      if (!data?.result) continue
      
      const r = data.result
      const updates = {}
      if (snap.pnl == null && r.pnl != null) updates.pnl = parseFloat(r.pnl)
      if (snap.win_rate == null && r.winRate != null) updates.win_rate = parseFloat(r.winRate) * 100
      if (snap.max_drawdown == null && r.maxDrawdown != null) updates.max_drawdown = parseFloat(r.maxDrawdown) * 100
      if (snap.trades_count == null && r.totalTradeCount != null) updates.trades_count = parseInt(r.totalTradeCount)
      
      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        updated++
      }
      await sleep(200)
    } catch {}
  }
  console.log(`  ✅ 补充了 ${updated} 条`)
}

// ============================================
// Bitget enrichment
// ============================================
async function enrichBitget() {
  console.log('\n📊 Bitget - 补充缺失字段...')
  const { data: snaps } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'bitget_futures')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null')
    .limit(500)
  
  console.log(`  需要补充: ${snaps?.length || 0} 条`)
  if (!snaps?.length) return
  
  let updated = 0
  for (const snap of snaps) {
    try {
      const data = await fetchJSON(`https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${snap.source_trader_id}`)
      if (!data?.data) continue
      
      const r = data.data
      const updates = {}
      if (snap.pnl == null && r.totalProfit != null) updates.pnl = parseFloat(r.totalProfit)
      if (snap.win_rate == null && r.winRate != null) updates.win_rate = parseFloat(r.winRate) * 100
      if (snap.max_drawdown == null && r.maxDrawDown != null) updates.max_drawdown = parseFloat(r.maxDrawDown) * 100
      if (snap.trades_count == null && r.totalTrades != null) updates.trades_count = parseInt(r.totalTrades)
      
      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        updated++
      }
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ 补充了 ${updated} 条`)
}

// ============================================
// MEXC enrichment - via contract API
// ============================================
async function enrichMEXC() {
  console.log('\n📊 MEXC - 补充缺失字段...')
  const { data: snaps } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown')
    .eq('source', 'mexc')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null')
    .limit(500)
  
  console.log(`  需要补充: ${snaps?.length || 0} 条`)
  if (!snaps?.length) return
  
  let updated = 0
  for (const snap of snaps) {
    try {
      const data = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${snap.source_trader_id}`)
      if (!data?.data) continue
      
      const r = data.data
      const updates = {}
      if (snap.pnl == null && r.totalProfit != null) updates.pnl = parseFloat(r.totalProfit)
      if (snap.win_rate == null && r.winRatio != null) updates.win_rate = parseFloat(r.winRatio) * 100
      if (snap.max_drawdown == null && r.maxDrawdown != null) updates.max_drawdown = parseFloat(r.maxDrawdown) * 100
      
      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        updated++
      }
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ 补充了 ${updated} 条`)
}

// ============================================
// KuCoin enrichment
// ============================================
async function enrichKuCoin() {
  console.log('\n📊 KuCoin - 补充缺失字段...')
  const { data: snaps } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'kucoin')
    .or('roi.is.null,win_rate.is.null,max_drawdown.is.null')
    .limit(500)
  
  console.log(`  需要补充: ${snaps?.length || 0} 条`)
  if (!snaps?.length) return
  
  let updated = 0
  for (const snap of snaps) {
    try {
      const data = await fetchJSON(`https://www.kucoin.com/_api/copy-trading/future/public/trader/detail?traderId=${snap.source_trader_id}`)
      if (!data?.data) continue
      
      const r = data.data
      const updates = {}
      if (snap.roi == null && r.roi != null) updates.roi = parseFloat(r.roi) * 100
      if (snap.pnl == null && r.pnl != null) updates.pnl = parseFloat(r.pnl)
      if (snap.win_rate == null && r.winRate != null) updates.win_rate = parseFloat(r.winRate) * 100
      if (snap.max_drawdown == null && r.maxDrawdown != null) updates.max_drawdown = parseFloat(r.maxDrawdown) * 100
      
      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        updated++
      }
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ 补充了 ${updated} 条`)
}

// ============================================
// CoinEx enrichment 
// ============================================
async function enrichCoinEx() {
  console.log('\n📊 CoinEx - 补充缺失字段...')
  const { data: snaps } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, pnl, win_rate, max_drawdown')
    .eq('source', 'coinex')
    .or('pnl.is.null,win_rate.is.null,max_drawdown.is.null')
    .limit(500)
  
  console.log(`  需要补充: ${snaps?.length || 0} 条`)
  if (!snaps?.length) return
  
  let updated = 0
  for (const snap of snaps) {
    try {
      const data = await fetchJSON(`https://www.coinex.com/res/copytrading/trader/info?trader_id=${snap.source_trader_id}`)
      if (!data?.data) continue
      
      const r = data.data
      const updates = {}
      if (snap.pnl == null && r.total_profit != null) updates.pnl = parseFloat(r.total_profit)
      if (snap.win_rate == null && r.win_rate != null) updates.win_rate = parseFloat(r.win_rate) * 100
      if (snap.max_drawdown == null && r.max_drawdown != null) updates.max_drawdown = parseFloat(r.max_drawdown) * 100
      
      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        updated++
      }
      await sleep(300)
    } catch {}
  }
  console.log(`  ✅ 补充了 ${updated} 条`)
}

// ============================================
// Binance Futures enrichment via proxy
// ============================================
async function enrichBinance() {
  console.log('\n📊 Binance Futures - 尝试通过代理补充...')
  if (!PROXY_URL) {
    console.log('  ⚠ 无代理，跳过')
    return
  }
  
  // Try to get fresh leaderboard data via proxy
  const periods = ['30D', '90D']
  for (const period of periods) {
    let page = 1
    let total = 0
    while (page <= 20) {
      try {
        const res = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list')}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageNumber: page,
            pageSize: 20,
            timeRange: period,
            dataType: 'ROI',
            favoriteOnly: false,
          }),
          signal: AbortSignal.timeout(10000),
        })
        const data = await res.json()
        
        if (data?.code !== 0 || !data?.data?.list?.length) break
        
        for (const item of data.data.list) {
          const { error } = await supabase.from('trader_snapshots').upsert({
            source: 'binance_futures',
            source_trader_id: item.leadPortfolioId || item.portfolioId,
            season_id: period === '30D' ? 'current_30d' : 'current_90d',
            roi: item.roi ? parseFloat(item.roi) * 100 : null,
            pnl: item.pnl ? parseFloat(item.pnl) : null,
            win_rate: item.winRate ? parseFloat(item.winRate) * 100 : null,
            max_drawdown: item.maxDrawdown ? parseFloat(item.maxDrawdown) * 100 : null,
            trades_count: item.tradeCount || null,
            follower_count: item.copierNum || null,
            arena_score: null,
            captured_at: new Date().toISOString(),
          }, { onConflict: 'source,source_trader_id,season_id' })
          if (!error) total++
        }
        
        page++
        await sleep(500)
      } catch (e) {
        console.log(`  ⚠ ${period} page ${page} 失败: ${e.message}`)
        break
      }
    }
    console.log(`  ${period}: ${total} 条`)
  }
}

// ============================================
// Main
// ============================================
async function main() {
  console.log('🚀 全平台数据补充开始')
  console.log(`代理: ${PROXY_URL || '未配置'}`)
  
  await enrichBinance()
  await enrichBybit()
  await enrichBitget()
  await enrichMEXC()
  await enrichKuCoin()
  await enrichCoinEx()
  
  console.log('\n✅ 全部完成!')
}

main().catch(console.error)
