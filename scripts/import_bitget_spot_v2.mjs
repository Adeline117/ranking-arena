/**
 * Bitget Spot Copy Trading 完整数据抓取 v2
 * 
 * 用法: node scripts/import_bitget_spot_v2.mjs [7D|30D|90D]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'bitget_spot'
const TARGET_COUNT = 100

// Spot URL
const PERIOD_CONFIG = {
  '7D': { url: 'https://www.bitget.com/copy-trading/spot/all?sort=1' },
  '30D': { url: 'https://www.bitget.com/copy-trading/spot/all?sort=2' },
  '90D': { url: 'https://www.bitget.com/copy-trading/spot/all?sort=0' },
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '90D'
}

async function fetchLeaderboard(browser, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n📋 抓取排行榜: ${config.url}`)
  
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  const traders = []
  
  try {
    await page.goto(config.url, { waitUntil: 'networkidle2', timeout: 45000 })
    await sleep(5000)
    
    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got') || text.includes('Accept')) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)
    
    // 获取交易员链接
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href*="/trader/"]')
      return Array.from(anchors).map(a => {
        const href = a.href
        const match = href.match(/\/trader\/([a-f0-9]+)\//)
        if (match) {
          return {
            traderId: match[1],
            text: a.textContent?.slice(0, 100),
          }
        }
        return null
      }).filter(Boolean)
    })
    
    // 去重
    const seen = new Set()
    for (const link of links) {
      if (!seen.has(link.traderId)) {
        seen.add(link.traderId)
        
        const text = link.text || ''
        const nickMatch = text.match(/^([^@]+)@/)
        const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
        
        traders.push({
          traderId: link.traderId,
          nickname: nickMatch ? nickMatch[1].trim() : link.traderId,
          roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0,
        })
      }
    }
    
    console.log(`  获取到 ${traders.length} 个交易员`)
    
    // 分页
    if (traders.length < TARGET_COUNT) {
      for (let pageNum = 2; pageNum <= 5; pageNum++) {
        if (traders.length >= TARGET_COUNT) break
        
        await page.evaluate(() => window.scrollTo(0, 3500))
        await sleep(1000)
        
        const clicked = await page.evaluate((pageNum) => {
          const items = document.querySelectorAll('.bit-pagination-item a, .bit-pagination-item')
          for (const item of items) {
            if (item.textContent?.trim() === String(pageNum)) {
              item.click()
              return true
            }
          }
          return false
        }, pageNum)
        
        if (!clicked) break
        
        await sleep(4000)
        
        const moreLinks = await page.evaluate(() => {
          const anchors = document.querySelectorAll('a[href*="/trader/"]')
          return Array.from(anchors).map(a => {
            const href = a.href
            const match = href.match(/\/trader\/([a-f0-9]+)\//)
            if (match) {
              return {
                traderId: match[1],
                text: a.textContent?.slice(0, 100),
              }
            }
            return null
          }).filter(Boolean)
        })
        
        for (const link of moreLinks) {
          if (!seen.has(link.traderId)) {
            seen.add(link.traderId)
            const text = link.text || ''
            const nickMatch = text.match(/^([^@]+)@/)
            const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
            traders.push({
              traderId: link.traderId,
              nickname: nickMatch ? nickMatch[1].trim() : link.traderId,
              roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0,
            })
          }
        }
        console.log(`  第${pageNum}页后: ${traders.length} 个`)
      }
    }
  } finally {
    await page.close()
  }
  
  return traders.slice(0, TARGET_COUNT)
}

async function fetchTraderDetails(browser, traderId, period) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  let details = {}
  
  try {
    // Spot 详情页
    const url = `https://www.bitget.com/copy-trading/trader/${traderId}/spot`
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    await sleep(4000)
    
    // 从页面提取数据
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}
      
      // ROI
      const roiMatch = text.match(/ROI[\s\n:]*([+-]?[\d,]+\.?\d*)%/i)
      if (roiMatch) result.roi = parseFloat(roiMatch[1].replace(/,/g, ''))
      
      // Total P&L
      const pnlMatch = text.match(/(?:Total P&?L|总收益|Profit)[\s\n:]*\$?([\d,]+\.?\d*)/i)
      if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
      
      // Win Rate
      const winMatch = text.match(/(?:Win rate|胜率)[\s\n:]*(\d+\.?\d*)%/i)
      if (winMatch) result.winRate = parseFloat(winMatch[1])
      
      // MDD
      const mddMatch = text.match(/(?:MDD|Max(?:imum)? Drawdown|最大回撤)[\s\n:]*(\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])
      
      // Followers
      const followMatch = text.match(/(?:Followers?|跟随者|Copiers?)[\s\n:]*(\d+)/i)
      if (followMatch) result.followers = parseInt(followMatch[1])
      
      return result
    })
    
    Object.assign(details, pageData)
    
  } catch (e) {
    // 忽略错误
  } finally {
    await page.close()
  }
  
  return details
}

async function saveTrader(trader, details, period, capturedAt, rank) {
  try {
    await supabase.from('trader_sources').upsert({
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: trader.traderId,
      handle: trader.nickname,
      is_active: true,
    }, { onConflict: 'source,source_trader_id' })
    
    const { error } = await supabase.from('trader_snapshots').insert({
      source: SOURCE,
      source_trader_id: trader.traderId,
      season_id: period,
      rank,
      roi: details.roi || trader.roi || 0,
      pnl: details.pnl || null,
      win_rate: details.winRate || null,
      max_drawdown: details.maxDrawdown || null,
      followers: details.followers || null,
      captured_at: capturedAt,
    })
    
    return !error
  } catch {
    return false
  }
}

async function main() {
  const period = getTargetPeriod()
  console.log(`\n========================================`)
  console.log(`Bitget Spot 完整数据抓取 v2 - ${period}`)
  console.log(`========================================`)
  console.log('时间:', new Date().toISOString())
  
  // 先清理旧数据
  console.log('\n🧹 清理旧数据...')
  await supabase.from('trader_snapshots').delete().eq('source', SOURCE).eq('season_id', period)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  
  try {
    const traders = await fetchLeaderboard(browser, period)
    
    if (traders.length === 0) {
      console.log('\n⚠ 未获取到交易员列表')
      return
    }
    
    console.log(`\n📋 TOP 5:`)
    traders.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.nickname} (${t.traderId.slice(0, 8)}...): ROI ${t.roi}%`)
    })
    
    console.log(`\n🔍 获取详情数据...`)
    const capturedAt = new Date().toISOString()
    let saved = 0
    
    for (let i = 0; i < traders.length; i++) {
      const trader = traders[i]
      process.stdout.write(`  ${i + 1}/${traders.length} ${trader.nickname.slice(0, 15).padEnd(15)} `)
      
      const details = await fetchTraderDetails(browser, trader.traderId, period)
      const success = await saveTrader(trader, details, period, capturedAt, i + 1)
      
      if (success) {
        saved++
        console.log(`✓ ROI:${(details.roi || trader.roi || 0).toFixed(1)}% PnL:$${(details.pnl || 0).toFixed(0)} WR:${(details.winRate || 0)}% MDD:${(details.maxDrawdown || 0)}%`)
      } else {
        console.log(`✗ 保存失败`)
      }
      
      if (i > 0 && i % 10 === 0) {
        await sleep(2000)
      }
    }
    
    console.log(`\n========================================`)
    console.log(`✅ 完成！保存: ${saved}/${traders.length}`)
    console.log(`========================================`)
    
  } finally {
    await browser.close()
  }
}

main().catch(console.error)
