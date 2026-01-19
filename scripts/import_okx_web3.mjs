/**
 * OKX Web3 排行榜数据抓取
 * 
 * 使用 Playwright 抓取 OKX Web3 链上跟单排行榜
 * 从 DOM 提取数据（SSR 渲染）
 * 
 * 用法: node scripts/import_okx_web3.mjs [7D|30D|90D]
 * 
 * 数据源: https://web3.okx.com/zh-hans/copy-trade/leaderboard/solana
 * 注意: OKX Web3 默认显示 7 日数据，时间段切换可能受限
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { validateTraderData, deduplicateTraders, printValidationResult } from './lib/data-validation.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'okx_web3'
// 使用英文版（中文版有地区限制）
const BASE_URL = 'https://web3.okx.com/copy-trade/leaderboard/solana'

const TARGET_COUNT = 100

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) {
    return arg
  }
  return '7D'  // OKX Web3 默认 7D
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 OKX Web3 ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log('URL:', BASE_URL)
  console.log(`目标: ${TARGET_COUNT} 个交易员`)
  console.log('⚠️ 注意: OKX Web3 主要显示 7 日数据')

  const traders = new Map()

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
  })

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',  // 使用英文避免地区限制
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    const page = await context.newPage()

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(8000)

    // 关闭弹窗
    try {
      await page.click('text=I understand', { timeout: 3000 })
      console.log('  已关闭提示弹窗')
    } catch (e) {}
    
    try {
      await page.click('text=Accept All Cookies', { timeout: 3000 })
      console.log('  已关闭 Cookie 弹窗')
    } catch (e) {}
    
    await sleep(2000)

    // 从 DOM 提取数据
    console.log('\n📊 从页面提取数据...')
    
    const pageTraders = await page.evaluate(() => {
      const results = []
      const pageText = document.body.innerText
      
      // 使用正则匹配交易员数据模式
      // 格式: 昵称/地址 \n +$xxx.xxK \n +xx.xx%
      const lines = pageText.split('\n').map(l => l.trim()).filter(l => l)
      
      for (let i = 0; i < lines.length - 2; i++) {
        const line = lines[i]
        const nextLine = lines[i + 1]
        const nextNextLine = lines[i + 2]
        
        // 检查是否是收益额格式 (+$xxx.xxK 或 +$xxx.xxM)
        const pnlMatch = nextLine?.match(/^\+\$([0-9,.]+)([KM])?$/)
        
        // 检查是否是收益率格式 (+xx.xx%)
        const roiMatch = nextNextLine?.match(/^\+([0-9.]+)%$/)
        
        if (pnlMatch && roiMatch) {
          // 提取昵称/地址
          let address = line
          let nickname = line
          
          // 如果是缩略地址格式 (xxxx...xxxx)
          const addrMatch = line.match(/([A-Za-z0-9]{4,8}\.\.\.[A-Za-z0-9]{4})/)
          if (addrMatch) {
            address = addrMatch[1]
          }
          
          // 解析 PnL
          let pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
          if (pnlMatch[2] === 'K') pnl *= 1000
          if (pnlMatch[2] === 'M') pnl *= 1000000
          
          // 解析 ROI
          const roi = parseFloat(roiMatch[1])
          
          // 过滤掉无效数据
          if (roi > 0 && !results.find(r => r.address === address)) {
            results.push({
              address,
              nickname,
              roi,
              pnl,
            })
          }
        }
      }
      
      return results
    })
    
    console.log(`  从页面提取到 ${pageTraders.length} 个交易员`)
    
    // 转换为标准格式
    pageTraders.forEach((item, idx) => {
      const traderId = item.address
      if (!traders.has(traderId)) {
        traders.set(traderId, {
          traderId,
          nickname: item.nickname,
          avatar: null,
          roi: item.roi,
          pnl: item.pnl,
          winRate: null,
          maxDrawdown: null,
          followers: null,
          rank: idx + 1,
        })
        
        if (traders.size <= 3) {
          console.log(`    #${idx + 1}: ROI ${item.roi.toFixed(2)}%, PnL $${item.pnl.toFixed(0)}, 昵称: ${item.nickname}`)
        }
      }
    })

    // 滚动页面获取更多数据
    let scrollAttempts = 0
    const maxScrollAttempts = 10
    
    while (traders.size < TARGET_COUNT && scrollAttempts < maxScrollAttempts) {
      const lastCount = traders.size
      
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(3000)
      
      // 再次提取数据
      const moreTraders = await page.evaluate(() => {
        const results = []
        const pageText = document.body.innerText
        const lines = pageText.split('\n').map(l => l.trim()).filter(l => l)
        
        for (let i = 0; i < lines.length - 2; i++) {
          const line = lines[i]
          const nextLine = lines[i + 1]
          const nextNextLine = lines[i + 2]
          
          const pnlMatch = nextLine?.match(/^\+\$([0-9,.]+)([KM])?$/)
          const roiMatch = nextNextLine?.match(/^\+([0-9.]+)%$/)
          
          if (pnlMatch && roiMatch) {
            let address = line
            const addrMatch = line.match(/([A-Za-z0-9]{4,8}\.\.\.[A-Za-z0-9]{4})/)
            if (addrMatch) address = addrMatch[1]
            
            let pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
            if (pnlMatch[2] === 'K') pnl *= 1000
            if (pnlMatch[2] === 'M') pnl *= 1000000
            
            const roi = parseFloat(roiMatch[1])
            
            if (roi > 0) {
              results.push({ address, nickname: line, roi, pnl })
            }
          }
        }
        
        return results
      })
      
      moreTraders.forEach((item, idx) => {
        const traderId = item.address
        if (!traders.has(traderId)) {
          traders.set(traderId, {
            traderId,
            nickname: item.nickname,
            avatar: null,
            roi: item.roi,
            pnl: item.pnl,
            winRate: null,
            maxDrawdown: null,
            followers: null,
            rank: traders.size + 1,
          })
        }
      })
      
      if (traders.size === lastCount) {
        scrollAttempts++
        console.log(`  滚动尝试 ${scrollAttempts}/${maxScrollAttempts}，无新数据`)
      } else {
        scrollAttempts = 0
        console.log(`  当前已获取: ${traders.size} 个交易员`)
      }
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    const screenshotPath = `/tmp/okx_web3_${period}_${Date.now()}.png`
    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log(`📸 截图保存到: ${screenshotPath}`)

  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员到数据库 (${SOURCE} - ${period})...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0
  let errors = 0

  for (const trader of traders) {
    try {
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        profile_url: trader.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: trader.winRate,
        max_drawdown: trader.maxDrawdown,
        followers: trader.followers || 0,
        captured_at: capturedAt,
      })

      if (error) {
        console.log(`    ✗ 保存失败 ${trader.traderId}: ${error.message}`)
        errors++
      } else {
        saved++
      }
    } catch (error) {
      console.log(`    ✗ 异常 ${trader.traderId}: ${error.message}`)
      errors++
    }
  }

  console.log(`  ✓ 保存成功: ${saved}`)
  if (errors > 0) console.log(`  ✗ 保存失败: ${errors}`)

  return { saved, errors }
}

async function main() {
  const period = getTargetPeriod()
  console.log(`\n========================================`)
  console.log(`OKX Web3 排行榜数据抓取`)
  console.log(`目标周期: ${period}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`目标数量: ${TARGET_COUNT} 个交易员`)
  console.log(`========================================`)

  try {
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log('\n⚠ 未获取到任何数据')
      console.log('请检查截图文件查看页面状态')
      process.exit(1)
    }

    const uniqueTraders = deduplicateTraders(traders)
    
    uniqueTraders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    uniqueTraders.forEach((t, idx) => t.rank = idx + 1)

    const topTraders = uniqueTraders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10 (按 ROI 排序):`)
    topTraders.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const validation = validateTraderData(topTraders, {}, SOURCE)
    const isValid = printValidationResult(validation, SOURCE)

    if (!isValid) {
      console.log('\n⚠️ 数据验证未完全通过，但仍保存数据')
    }

    const result = await saveTraders(topTraders, period)

    console.log(`\n========================================`)
    console.log(`✅ 完成！`)
    console.log(`   来源: ${SOURCE}`)
    console.log(`   周期: ${period}`)
    console.log(`   总数: ${topTraders.length}`)
    console.log(`   TOP ROI: ${validation.stats.topRoi.toFixed(2)}%`)
    console.log(`   平均 ROI: ${validation.stats.avgRoi.toFixed(2)}%`)
    console.log(`   保存: ${result.saved}`)
    console.log(`   时间: ${new Date().toISOString()}`)
    console.log(`========================================`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
