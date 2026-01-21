/**
 * 使用 Puppeteer 抓取 Binance 仓位历史
 * 因为 Position History API 需要网页会话
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Error: Missing Supabase config')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const SOURCE = 'binance_futures'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 使用 Puppeteer 获取仓位历史
 */
async function fetchPositionHistory(browser, portfolioId, handle) {
  const page = await browser.newPage()
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )
  
  let positions = []
  let currentPositions = []
  
  // 监听 API 响应
  page.on('response', async (response) => {
    const url = response.url()
    
    try {
      // 监听仓位历史 API
      if (url.includes('position-history') || url.includes('closed-position')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const list = data.data.list || data.data || []
          if (Array.isArray(list) && list.length > 0) {
            positions = list
            console.log(`    ✓ 历史仓位: ${positions.length} 条`)
          }
        }
      }
      
      // 监听当前持仓 API
      if (url.includes('current-position') || url.includes('open-position')) {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          const list = Array.isArray(data.data) ? data.data : (data.data.list || [])
          if (list.length > 0) {
            currentPositions = list
            console.log(`    ✓ 当前持仓: ${currentPositions.length} 条`)
          }
        }
      }
    } catch {
      // 忽略解析错误
    }
  })
  
  try {
    // 访问交易员详情页
    const url = `https://www.binance.com/en/copy-trading/lead-details/${portfolioId}`
    console.log(`  访问: ${handle}`)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
    
    // 等待页面加载
    await delay(3000)
    
    // 尝试点击 "Position History" 或 "Closed Positions" tab
    try {
      const tabs = await page.$$('button, [role="tab"], .tab, div[class*="tab"]')
      for (const tab of tabs) {
        const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', tab)
        if (text.includes('position') || text.includes('history') || text.includes('closed')) {
          await tab.click()
          await delay(2000)
          break
        }
      }
    } catch {
      // 忽略点击错误
    }
    
    // 再等待一下让数据加载
    await delay(2000)
    
  } catch (error) {
    console.error(`    ✗ 页面加载失败: ${error.message}`)
  }
  
  await page.close()
  return { positions, currentPositions }
}

/**
 * 存储仓位历史
 * Binance API 返回字段: id, symbol, type, opened, closed, avgCost, avgClosePrice, closingPnl, maxOpenInterest, closedVolume, isolated, side, status
 */
async function storePositionHistory(portfolioId, positions, capturedAt) {
  if (!positions || positions.length === 0) return 0
  
  const items = positions.map(p => {
    // 解析方向: side 字段值为 "Long" 或 "Short"
    const direction = (p.side || '').toLowerCase().includes('short') ? 'short' : 'long'
    
    // opened/closed 是毫秒时间戳，closed=0 表示还在持仓
    const openTime = p.opened ? new Date(p.opened).toISOString() : null
    const closeTime = p.closed && p.closed > 0 ? new Date(p.closed).toISOString() : null
    
    return {
      source: SOURCE,
      source_trader_id: portfolioId,
      symbol: p.symbol || '',
      direction: direction,
      open_time: openTime,
      close_time: closeTime,
      entry_price: parseFloat(p.avgCost || 0),
      exit_price: parseFloat(p.avgClosePrice || 0),
      pnl_usd: parseFloat(p.closingPnl || 0),
      pnl_pct: 0, // API 没有返回 ROE
      max_position_size: parseFloat(p.maxOpenInterest || 0),
      status: closeTime ? 'closed' : 'open',
      captured_at: capturedAt,
    }
  }).filter(i => i.symbol && i.open_time)
  
  if (items.length === 0) return 0
  
  const { error } = await supabase
    .from('trader_position_history')
    .upsert(items, { onConflict: 'source,source_trader_id,symbol,open_time' })
  
  if (error) {
    console.error(`    存储失败: ${error.message}`)
    return 0
  }
  
  return items.length
}

/**
 * 存储当前持仓
 */
async function storeCurrentPositions(portfolioId, positions, capturedAt) {
  if (!positions || positions.length === 0) return 0
  
  // 先删除旧数据
  await supabase
    .from('trader_portfolio')
    .delete()
    .eq('source', SOURCE)
    .eq('source_trader_id', portfolioId)
  
  const items = positions.map(p => ({
    source: SOURCE,
    source_trader_id: portfolioId,
    symbol: p.symbol || '',
    direction: (p.positionSide || '').toLowerCase().includes('short') ? 'short' : 'long',
    entry_price: parseFloat(p.entryPrice || p.avgEntryPrice || 0),
    pnl: parseFloat(p.unrealizedProfit || p.unRealizedProfit || 0),
    invested_pct: parseFloat(p.positionAmt || p.amount || 0),
    captured_at: capturedAt,
  })).filter(i => i.symbol)
  
  if (items.length === 0) return 0
  
  const { error } = await supabase.from('trader_portfolio').insert(items)
  
  if (error) {
    console.error(`    存储当前持仓失败: ${error.message}`)
    return 0
  }
  
  return items.length
}

async function main() {
  console.log('=== Binance 仓位历史抓取 (Puppeteer) ===\n')
  
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
  
  // 启动浏览器
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  
  let historyCount = 0
  let portfolioCount = 0
  const capturedAt = new Date().toISOString()
  const startTime = Date.now()
  
  try {
    for (let i = 0; i < traders.length; i++) {
      const t = traders[i]
      console.log(`[${i + 1}/${traders.length}] ${t.handle || t.source_trader_id}`)
      
      try {
        const { positions, currentPositions } = await fetchPositionHistory(browser, t.source_trader_id, t.handle)
        
        const histSaved = await storePositionHistory(t.source_trader_id, positions, capturedAt)
        const curSaved = await storeCurrentPositions(t.source_trader_id, currentPositions, capturedAt)
        
        historyCount += histSaved
        portfolioCount += curSaved
        
        if (histSaved > 0 || curSaved > 0) {
          console.log(`    保存: 历史${histSaved} 当前${curSaved}`)
        }
      } catch (e) {
        console.error(`    错误: ${e.message}`)
      }
      
      // 每 10 个打印进度
      if ((i + 1) % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
        console.log(`\n--- 进度: ${i + 1}/${traders.length}, 已用 ${elapsed} 分钟 ---\n`)
      }
      
      // 间隔避免被封
      await delay(2000)
    }
  } finally {
    await browser.close()
  }
  
  console.log(`\n✅ 完成！历史仓位: ${historyCount} 条, 当前持仓: ${portfolioCount} 条`)
}

main().catch(console.error)
