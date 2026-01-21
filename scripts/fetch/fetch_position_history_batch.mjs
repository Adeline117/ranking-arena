/**
 * 批量抓取 Binance Futures 仓位历史 - 稳定版
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const delay = (ms) => new Promise(r => setTimeout(r, ms))

async function fetchPositions(browser, portfolioId) {
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  let positions = []
  
  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('position')) {
      try {
        const d = await res.json()
        if (d.data?.list?.length > 0) {
          positions = d.data.list
        }
      } catch {}
    }
  })
  
  try {
    await page.goto(`https://www.binance.com/en/copy-trading/lead-details/${portfolioId}`, {
      waitUntil: 'networkidle2',
      timeout: 40000,
    })
    
    await delay(2000)
    
    // 点击 Position History tab
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"], button')
      for (const t of tabs) {
        const text = (t.textContent || '').toLowerCase()
        if (text.includes('position') && text.includes('history')) {
          t.click()
          return
        }
      }
    }).catch(() => {})
    
    await delay(3000)
  } catch (e) {
    // 忽略导航错误
  }
  
  await page.close().catch(() => {})
  return positions
}

async function storePositions(portfolioId, positions, capturedAt) {
  if (!positions || positions.length === 0) return 0
  
  const items = positions.map(p => ({
    source: 'binance_futures',
    source_trader_id: portfolioId,
    symbol: p.symbol,
    direction: (p.side || '').toLowerCase().includes('short') ? 'short' : 'long',
    open_time: p.opened ? new Date(p.opened).toISOString() : null,
    close_time: p.closed > 0 ? new Date(p.closed).toISOString() : null,
    entry_price: parseFloat(p.avgCost || 0),
    exit_price: parseFloat(p.avgClosePrice || 0),
    pnl_usd: parseFloat(p.closingPnl || 0),
    pnl_pct: 0,
    status: 'closed',
    captured_at: capturedAt,
  })).filter(i => i.symbol && i.open_time)
  
  if (items.length === 0) return 0
  
  // 先删除旧数据，再插入新数据
  await supabase.from('trader_position_history')
    .delete()
    .eq('source', 'binance_futures')
    .eq('source_trader_id', portfolioId)
  
  const { error } = await supabase.from('trader_position_history').insert(items)
  if (error) {
    console.log(`    存储失败: ${error.message}`)
    return 0
  }
  return items.length
}

async function main() {
  console.log('=== Binance 仓位历史批量抓取 ===\n')
  
  // 获取所有交易员
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'binance_futures')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
  
  console.log(`共 ${traders.length} 个交易员\n`)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  
  const capturedAt = new Date().toISOString()
  let success = 0
  let totalRecords = 0
  const startTime = Date.now()
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    const name = t.handle || t.source_trader_id
    
    try {
      const positions = await fetchPositions(browser, t.source_trader_id)
      
      if (positions.length > 0) {
        const saved = await storePositions(t.source_trader_id, positions, capturedAt)
        if (saved > 0) {
          console.log(`[${i + 1}/${traders.length}] ${name}: ✓ ${saved} 条`)
          success++
          totalRecords += saved
        } else {
          console.log(`[${i + 1}/${traders.length}] ${name}: (无数据)`)
        }
      } else {
        console.log(`[${i + 1}/${traders.length}] ${name}: (私密/空)`)
      }
    } catch (e) {
      console.log(`[${i + 1}/${traders.length}] ${name}: 错误 ${e.message}`)
    }
    
    // 每 20 个打印进度
    if ((i + 1) % 20 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      const eta = (((Date.now() - startTime) / (i + 1)) * (traders.length - i - 1) / 1000 / 60).toFixed(1)
      console.log(`\n--- 进度: ${i + 1}/${traders.length}, 成功: ${success}, 记录: ${totalRecords}, 用时: ${elapsed}分, 预计剩余: ${eta}分 ---\n`)
    }
    
    // 延迟防止限流
    await delay(2000)
  }
  
  await browser.close()
  
  console.log(`\n✅ 完成！成功 ${success} 个交易员，共 ${totalRecords} 条仓位记录`)
}

main().catch(console.error)
