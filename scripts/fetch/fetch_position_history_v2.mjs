/**
 * 使用 Puppeteer 抓取 Binance 仓位历史 - 稳定版
 * 增加重试、错误处理和更长延迟
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const SOURCE = 'binance_futures'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 单次抓取一个交易员的仓位历史
 */
async function fetchOne(portfolioId, handle, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let browser
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
      
      const page = await browser.newPage()
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
      
      let positions = []
      
      // 等待数据的 Promise
      const dataPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => resolve([]), 25000)
        
        page.on('response', async (response) => {
          const url = response.url()
          if (url.includes('position-history')) {
            try {
              const data = await response.json()
              if (data.code === '000000' && data.data?.list?.length > 0) {
                clearTimeout(timeout)
                resolve(data.data.list)
              }
            } catch {}
          }
        })
      })
      
      // 访问页面
      await page.goto(`https://www.binance.com/en/copy-trading/lead-details/${portfolioId}`, {
        waitUntil: 'networkidle2',
        timeout: 45000,
      })
      
      await delay(2000)
      
      // 点击 History tab
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, [role="tab"]')
        for (const b of btns) {
          if (b.textContent?.toLowerCase().includes('history')) {
            b.click()
            break
          }
        }
      })
      
      // 等待数据
      positions = await dataPromise
      
      await browser.close()
      
      if (positions.length > 0) {
        return positions
      }
      
      // 如果没有数据，可能需要重试
      if (attempt < retries) {
        console.log(`    重试 ${attempt + 1}/${retries}...`)
        await delay(3000)
      }
      
    } catch (error) {
      if (browser) await browser.close().catch(() => {})
      
      if (attempt < retries) {
        console.log(`    错误: ${error.message}, 重试...`)
        await delay(3000)
      } else {
        console.log(`    失败: ${error.message}`)
      }
    }
  }
  
  return []
}

/**
 * 存储仓位历史
 */
async function storePositions(portfolioId, positions, capturedAt) {
  if (!positions || positions.length === 0) return 0
  
  const items = positions.map(p => {
    const direction = (p.side || '').toLowerCase().includes('short') ? 'short' : 'long'
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
      pnl_pct: 0,
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

async function main() {
  console.log('=== Binance 仓位历史抓取 v2 ===\n')
  
  // 获取所有交易员
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', SOURCE)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
  
  console.log(`找到 ${traders.length} 个交易员\n`)
  
  const capturedAt = new Date().toISOString()
  let success = 0
  let total = 0
  const startTime = Date.now()
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    console.log(`[${i + 1}/${traders.length}] ${t.handle || t.source_trader_id}`)
    
    const positions = await fetchOne(t.source_trader_id, t.handle)
    
    if (positions.length > 0) {
      const saved = await storePositions(t.source_trader_id, positions, capturedAt)
      if (saved > 0) {
        console.log(`    ✓ 保存 ${saved} 条`)
        success++
        total += saved
      }
    }
    
    // 每 10 个打印进度
    if ((i + 1) % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      console.log(`\n--- 进度: ${i + 1}/${traders.length}, 成功: ${success}, 总记录: ${total}, 用时: ${elapsed}分钟 ---\n`)
    }
    
    // 延迟 3 秒，避免被限流
    await delay(3000)
  }
  
  console.log(`\n✅ 完成！成功 ${success} 个交易员，共 ${total} 条仓位记录`)
}

main().catch(console.error)
