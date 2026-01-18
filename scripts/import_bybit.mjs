/**
 * Bybit Copy Trading 排行榜数据抓取
 * 
 * 使用 puppeteer-extra + stealth 插件
 * 需要点击 "All Traders" tab 进入完整列表，然后点击 "Top ROI" 排序
 * 
 * 用法: node scripts/import_bybit.mjs [7D|30D|90D]
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

const SOURCE = 'bybit'
const BASE_URL = 'https://www.bybit.com/zh-CN/copyTrade/'
const TARGET_COUNT = 100
const MAX_SCROLLS = 100

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '90D'
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Bybit ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  let allTraders = []

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 加载超时')
    }
    await sleep(8000)

    // 关闭地区弹窗
    console.log('🔄 关闭地区弹窗...')
    await page.evaluate(() => {
      document.querySelectorAll('button, div').forEach(btn => {
        if (btn.textContent?.includes("don't live")) btn.click()
      })
    })
    await sleep(2000)

    // 滚动到 Tab 栏位置
    console.log('🔄 滚动到 Tab 栏...')
    await page.evaluate(() => window.scrollTo(0, 600))
    await sleep(2000)

    // 点击 "All Traders" Tab（使用更精确的选择器）
    console.log('🔄 点击 All Traders Tab...')
    const clickedAllTraders = await page.evaluate(() => {
      // 查找包含 "All Traders" 文本的元素
      const allElements = document.querySelectorAll('*')
      for (const el of allElements) {
        if (el.children.length === 0 || el.children.length === 1) {
          const text = el.textContent?.trim()
          if (text === 'All Traders') {
            el.click()
            console.log('点击了 All Traders')
            return true
          }
        }
      }
      return false
    })
    console.log(`  点击结果: ${clickedAllTraders}`)
    await sleep(3000)

    // 截图检查
    await page.screenshot({ path: `/tmp/bybit_after_tab_${Date.now()}.png` })

    // 点击 "Top ROI" 按钮
    console.log('🔄 点击 Top ROI...')
    await page.evaluate(() => {
      const elements = document.querySelectorAll('*')
      for (const el of elements) {
        const text = el.textContent?.trim()
        if (text === 'Top ROI') {
          el.click()
          return true
        }
      }
      return false
    })
    await sleep(3000)

    // 提取数据的函数
    const extractTraders = async () => {
      const text = await page.evaluate(() => document.body.innerText)
      const traders = []
      const seen = new Set()
      
      const chunks = text.split('Copy')
      
      chunks.forEach(chunk => {
        const lines = chunk.split('\n').map(l => l.trim()).filter(l => l)
        
        let roi = null
        let nickname = null
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          
          // 找 +xxx.xx% 格式的 ROI
          if (line.match(/^\+[\d,.]+[‎]?%$/)) {
            roi = parseFloat(line.replace(/[^\d.]/g, ''))
            
            // 向前找用户名
            for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
              const prev = lines[j]
              if (prev && prev.length >= 3 && prev.length <= 30 &&
                  !prev.match(/^[\d,.%+\/-]+$/) &&
                  prev !== 'ROI' && prev !== '100' &&
                  !prev.match(/^\d+d$/i) &&
                  !prev.includes('Drawdown') && !prev.includes('Sharpe') &&
                  !prev.includes('View All') && !prev.includes('Traders') &&
                  !prev.includes('Master') && !prev.includes('Leaderboard') &&
                  !prev.includes('Check')) {
                nickname = prev
                break
              }
            }
            break
          }
        }
        
        if (nickname && roi > 0 && !seen.has(nickname)) {
          seen.add(nickname)
          traders.push({ traderId: nickname, nickname, roi, rank: traders.length + 1 })
        }
      })
      
      return traders
    }

    // 滚动并收集数据
    console.log('\n📄 滚动收集数据...')
    const seenIds = new Set()
    let noNewDataCount = 0
    
    for (let scroll = 1; scroll <= MAX_SCROLLS; scroll++) {
      // 滚动页面
      await page.evaluate(() => window.scrollBy(0, 500))
      await sleep(600)
      
      // 每5次滚动提取一次
      if (scroll % 5 === 0) {
        const pageTraders = await extractTraders()
        
        let newCount = 0
        pageTraders.forEach(t => {
          if (!seenIds.has(t.traderId)) {
            seenIds.add(t.traderId)
            allTraders.push({ ...t, avatar: null, pnl: null, winRate: null, maxDrawdown: null, followers: null })
            newCount++
          }
        })
        
        console.log(`  滚动 ${scroll}: 当前 ${pageTraders.length} 个，新增 ${newCount}，累计 ${allTraders.length}`)
        
        if (allTraders.length >= TARGET_COUNT) {
          console.log(`  ✓ 已达到目标数量 ${TARGET_COUNT}`)
          break
        }
        
        if (newCount === 0) {
          noNewDataCount++
          if (noNewDataCount >= 5) {
            console.log('  连续5次无新数据，停止')
            break
          }
        } else {
          noNewDataCount = 0
        }
      }
    }

    console.log(`\n📊 共获取 ${allTraders.length} 个交易员数据`)
    
    await page.screenshot({ path: `/tmp/bybit_${period}_${Date.now()}.png`, fullPage: true })

  } finally {
    await browser.close()
  }

  return allTraders
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
  console.log(`Bybit 数据抓取 - ${period}`)
  console.log(`========================================`)

  const traders = await fetchLeaderboardData(period)

  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据，请检查截图')
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
