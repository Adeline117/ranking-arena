/**
 * MEXC Copy Trading 排行榜数据抓取
 * 
 * 使用 puppeteer-extra + stealth 插件
 * 需要点击 "All Traders" Tab 来获取完整列表
 * 
 * 用法: node scripts/import_mexc.mjs [7D|30D|90D]
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

const SOURCE = 'mexc'
const BASE_URL = 'https://www.mexc.com/futures/copyTrade/home'
const TARGET_COUNT = 100
const MAX_PAGES = 15

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '90D'
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 MEXC ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const traders = new Map()

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 提取交易员数据
    const extractTraders = async () => {
      const text = await page.evaluate(() => document.body.innerText)
      const results = []
      const seen = new Set()
      
      // 分割成小块
      const chunks = text.split(/Copy Trade|跟单|关注|Copy/)
      
      chunks.forEach(chunk => {
        const lines = chunk.split('\n').map(l => l.trim()).filter(l => l)
        
        let roi = null
        let nickname = null
        
        for (const line of lines) {
          // 找 ROI% (正数)
          const roiMatch = line.match(/^([+-]?\d{1,6}(?:,?\d{3})*(?:\.\d+)?)\s*%$/)
          if (roiMatch) {
            const val = parseFloat(roiMatch[1].replace(/,/g, ''))
            if (val > 0 && (!roi || val > roi)) {
              roi = val
            }
          }
        }
        
        // 找用户名
        for (const line of lines) {
          if (line.length >= 2 && line.length <= 25 &&
              !line.match(/^[+-]?\d/) && !line.includes('%') &&
              !line.includes('ROI') && !line.includes('PNL') &&
              !line.includes('MDD') && !line.includes('Followers') &&
              !line.includes('Days') && !line.includes('USDT')) {
            nickname = line
            break
          }
        }
        
        if (nickname && roi > 0 && !seen.has(nickname)) {
          seen.add(nickname)
          results.push({ traderId: nickname, nickname, roi, rank: results.length + 1 })
        }
      })
      
      return results
    }

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 加载超时')
    }
    await sleep(8000)

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*="close"]').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('关闭') || text.includes('OK') || text.includes('Got it') || text.includes('确定')) {
          try { btn.click() } catch (e) {}
        }
      })
    })
    await sleep(2000)

    // 点击 "All Traders" Tab
    console.log('🔄 点击 All Traders Tab...')
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('*')
      for (const tab of tabs) {
        const text = tab.textContent?.trim()
        if (text === 'All Traders' || text === '全部交易员' || text === 'Top Traders') {
          tab.click()
          return true
        }
      }
      return false
    })
    await sleep(3000)

    // 点击 ROI 排序
    console.log('🔄 点击 ROI 排序...')
    await page.evaluate(() => {
      const elements = document.querySelectorAll('*')
      for (const el of elements) {
        const text = el.textContent?.trim()
        if (text === 'ROI' || text === 'ROI%' || text === '收益率') {
          el.click()
          return
        }
      }
    })
    await sleep(3000)

    // 分页获取
    console.log('\n📄 分页获取数据...')
    const seenIds = new Set()
    let noNewDataCount = 0
    
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      console.log(`  === 第 ${pageNum} 页 ===`)
      
      // 提取当前页数据
      const pageTraders = await extractTraders()
      
      let newCount = 0
      pageTraders.forEach(t => {
        if (!seenIds.has(t.traderId)) {
          seenIds.add(t.traderId)
          traders.set(t.traderId, { ...t, avatar: null, pnl: null, winRate: null, maxDrawdown: null, followers: null })
          newCount++
        }
      })
      
      console.log(`  提取 ${pageTraders.length} 个，新增 ${newCount}，累计 ${traders.size}`)
      
      if (traders.size >= TARGET_COUNT) {
        console.log(`  ✓ 已达到目标`)
        break
      }
      
      if (newCount === 0) {
        noNewDataCount++
        if (noNewDataCount >= 3) {
          console.log('  连续3次无新数据')
          break
        }
      } else {
        noNewDataCount = 0
      }
      
      // 翻页
      const clicked = await page.evaluate((targetPage) => {
        const pagers = document.querySelectorAll('[class*="pagination"] *, [class*="pager"] *, button, a, span')
        for (const p of pagers) {
          const text = p.textContent?.trim()
          if (text === String(targetPage)) {
            const isInCard = p.closest('[class*="card"], [class*="trader"]')
            if (!isInCard) {
              p.click()
              return true
            }
          }
        }
        // 尝试下一页
        const nexts = document.querySelectorAll('[class*="next"], [aria-label*="next"]')
        for (const n of nexts) {
          if (n.offsetParent && !n.disabled) {
            n.click()
            return true
          }
        }
        return false
      }, pageNum + 1)
      
      if (clicked) {
        console.log(`  ✓ 翻页成功`)
        await sleep(3000)
      } else {
        await page.evaluate(() => window.scrollBy(0, 800))
        await sleep(2000)
      }
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)
    
    await page.screenshot({ path: `/tmp/mexc_${period}_${Date.now()}.png`, fullPage: true })

  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0, errors = 0

  for (const trader of traders) {
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
        rank: trader.rank,
        roi: trader.roi,
        captured_at: capturedAt,
      })
      if (error) errors++
      else saved++
    } catch (e) { errors++ }
  }

  console.log(`  ✓ 保存: ${saved}, 失败: ${errors}`)
  return { saved, errors }
}

async function main() {
  const period = getTargetPeriod()
  console.log(`\n========================================`)
  console.log(`MEXC 数据抓取 - ${period}`)
  console.log(`========================================`)

  const traders = await fetchLeaderboardData(period)

  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据')
    return
  }

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  traders.forEach((t, idx) => t.rank = idx + 1)

  const top100 = traders.slice(0, TARGET_COUNT)

  console.log(`\n📋 TOP 10:`)
  top100.slice(0, 10).forEach((t, idx) => {
    console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
  })

  const result = await saveTraders(top100, period)

  console.log(`\n========================================`)
  console.log(`✅ 完成！总数: ${top100.length}, TOP ROI: ${top100[0]?.roi?.toFixed(2)}%`)
  console.log(`========================================`)
}

main()
