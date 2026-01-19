/**
 * 为所有 Binance Futures 交易员抓取详细数据
 * 包括：详细统计、资产偏好、收益曲线、持仓历史、当前持仓
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Error: Missing Supabase config')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const BINANCE_API_BASE = 'https://www.binance.com'
const TIME_RANGES = ['7D', '30D', '90D']
const SOURCE = 'binance_futures'

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchApi(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { headers: DEFAULT_HEADERS })
      if (!response.ok) {
        if (response.status === 429) {
          console.log('    Rate limited, waiting...')
          await delay(3000)
          continue
        }
        return null
      }
      const data = await response.json()
      if (data.code === '000000' && data.data !== null) return data.data
      return null
    } catch (e) {
      if (i < retries - 1) await delay(1000)
    }
  }
  return null
}

async function fetchAndStore(portfolioId, handle) {
  const capturedAt = new Date().toISOString()
  let hasData = false
  
  for (const timeRange of TIME_RANGES) {
    // 1. Performance -> Stats Detail
    const perfUrl = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${portfolioId}&timeRange=${timeRange}`
    const perf = await fetchApi(perfUrl)
    if (perf) {
      hasData = true
      await supabase.from('trader_stats_detail').delete()
        .eq('source', SOURCE).eq('source_trader_id', portfolioId).eq('period', timeRange)
      await supabase.from('trader_stats_detail').insert({
        source: SOURCE,
        source_trader_id: portfolioId,
        period: timeRange,
        sharpe_ratio: parseFloat(perf.sharpRatio) || 0,
        max_drawdown: parseFloat(perf.mdd) || 0,
        copiers_pnl: parseFloat(perf.copierPnl) || 0,
        winning_positions: parseInt(perf.winOrders) || 0,
        total_positions: parseInt(perf.totalOrder) || 0,
        captured_at: capturedAt,
      })
    }
    
    // 2. Asset Breakdown
    const assetUrl = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance/coin?portfolioId=${portfolioId}&timeRange=${timeRange}`
    const assetData = await fetchApi(assetUrl)
    if (assetData?.data?.length > 0) {
      await supabase.from('trader_asset_breakdown').delete()
        .eq('source', SOURCE).eq('source_trader_id', portfolioId).eq('period', timeRange)
      const items = assetData.data.map(a => ({
        source: SOURCE,
        source_trader_id: portfolioId,
        period: timeRange,
        symbol: a.asset,
        weight_pct: parseFloat(a.volume) || 0,
        captured_at: capturedAt,
      })).filter(i => i.symbol && i.weight_pct > 0)
      if (items.length > 0) await supabase.from('trader_asset_breakdown').insert(items)
    }
    
    // 3. ROI/PnL Chart -> Equity Curve
    const roiUrl = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=${portfolioId}&timeRange=${timeRange}`
    const roiData = await fetchApi(roiUrl)
    const pnlUrl = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/chart-data?dataType=PNL&portfolioId=${portfolioId}&timeRange=${timeRange}`
    const pnlData = await fetchApi(pnlUrl)
    if (roiData?.length > 0) {
      const pnlMap = new Map((pnlData || []).map(p => [p.dateTime, parseFloat(p.value) || 0]))
      await supabase.from('trader_equity_curve').delete()
        .eq('source', SOURCE).eq('source_trader_id', portfolioId).eq('period', timeRange)
      const curveItems = roiData.map(r => ({
        source: SOURCE,
        source_trader_id: portfolioId,
        period: timeRange,
        data_date: new Date(r.dateTime).toISOString().split('T')[0],
        roi_pct: parseFloat(r.value) || 0,
        pnl_usd: pnlMap.get(r.dateTime) || 0,
        captured_at: capturedAt,
      })).filter(i => i.data_date)
      if (curveItems.length > 0) await supabase.from('trader_equity_curve').insert(curveItems)
    }
    
    await delay(150)
  }
  
  // 4. Position History
  const posHistUrl = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/position-history?portfolioId=${portfolioId}&pageNumber=1&pageSize=50`
  const posHist = await fetchApi(posHistUrl)
  if (posHist?.list?.length > 0) {
    const posItems = posHist.list.map(p => ({
      source: SOURCE,
      source_trader_id: portfolioId,
      symbol: p.symbol || '',
      direction: (p.positionSide || '').toLowerCase().includes('short') ? 'short' : 'long',
      open_time: p.openTime ? new Date(parseInt(p.openTime)).toISOString() : null,
      close_time: p.closeTime ? new Date(parseInt(p.closeTime)).toISOString() : null,
      entry_price: parseFloat(p.entryPrice) || 0,
      exit_price: parseFloat(p.markPrice || p.closePrice) || 0,
      pnl_usd: parseFloat(p.pnl) || 0,
      pnl_pct: parseFloat(p.roe) * 100 || 0,
      status: 'closed',
      captured_at: capturedAt,
    })).filter(i => i.symbol && i.open_time)
    if (posItems.length > 0) {
      await supabase.from('trader_position_history').upsert(posItems, 
        { onConflict: 'source,source_trader_id,symbol,open_time' })
    }
  }
  
  // 5. Current Positions
  const curPosUrl = `${BINANCE_API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/current-position?portfolioId=${portfolioId}`
  const curPos = await fetchApi(curPosUrl)
  if (curPos?.length > 0) {
    await supabase.from('trader_portfolio').delete()
      .eq('source', SOURCE).eq('source_trader_id', portfolioId)
    const portfolioItems = curPos.map(p => ({
      source: SOURCE,
      source_trader_id: portfolioId,
      symbol: p.symbol || '',
      direction: (p.positionSide || '').toLowerCase().includes('short') ? 'short' : 'long',
      entry_price: parseFloat(p.entryPrice) || 0,
      pnl: parseFloat(p.unrealizedProfit) || 0,
      invested_pct: parseFloat(p.positionAmt) || 0,
      captured_at: capturedAt,
    })).filter(i => i.symbol)
    if (portfolioItems.length > 0) await supabase.from('trader_portfolio').insert(portfolioItems)
  }
  
  return hasData
}

async function main() {
  console.log('=== Binance Futures 详细数据抓取 ===\n')
  
  // 获取所有交易员
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', SOURCE)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
  
  if (error) {
    console.error('获取交易员列表失败:', error)
    process.exit(1)
  }
  
  console.log(`找到 ${traders.length} 个交易员\n`)
  
  let success = 0, fail = 0
  const startTime = Date.now()
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    try {
      const hasData = await fetchAndStore(t.source_trader_id, t.handle)
      if (hasData) success++
      else fail++
      
      // 每 10 个打印进度
      if ((i + 1) % 10 === 0 || i === traders.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        const eta = (((Date.now() - startTime) / (i + 1)) * (traders.length - i - 1) / 1000).toFixed(0)
        console.log(`[${i + 1}/${traders.length}] 成功:${success} 失败:${fail} | 已用:${elapsed}s 剩余:${eta}s`)
      }
    } catch (e) {
      fail++
      console.error(`  ✗ ${t.handle}: ${e.message}`)
    }
    
    await delay(200)
  }
  
  console.log(`\n✅ 完成！成功: ${success}, 失败: ${fail}`)
}

main()
