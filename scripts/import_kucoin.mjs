/**
 * KuCoin Copy Trading 排行榜数据抓取
 * 
 * KuCoin 使用 "days as lead" 筛选：
 * - 7D: days as lead >= 7
 * - 30D: days as lead >= 30
 * - 90D: days as lead >= 90
 * 
 * 用法: node scripts/import_kucoin.mjs [7D|30D|90D]
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

const SOURCE = 'kucoin'
const BASE_URL = 'https://www.kucoin.com/copytrading'
const TARGET_COUNT = 100
const MAX_PAGES = 25

const PERIOD_CONFIG = {
  '7D': { minDays: 7 },
  '30D': { minDays: 30 },
  '90D': { minDays: 90 },
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['7D', '30D', '90D'] // 默认抓取所有时间段
}

async function fetchLeaderboardData(period) {
  const config = PERIOD_CONFIG[period]
  
  console.log(`\n=== 抓取 KuCoin ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员 (days as lead >= ${config.minDays})`)

  const allTraders = []

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 拦截 API 响应
    page.on('response', async response => {
      const url = response.url()
      if (url.includes('leaderboard/query')) {
        try {
          const data = JSON.parse(await response.text())
          if (data.data && data.data.items) {
            data.data.items.forEach(t => {
              // 避免重复
              if (!allTraders.find(x => x.leadConfigId === t.leadConfigId)) {
                allTraders.push({
                  traderId: t.leadConfigId,
                  nickName: t.nickName,
                  pnl30d: t.thirtyDayPnlRatio,
                  pnlTotal: t.totalPnlRatio,
                  daysAsLeader: t.daysAsLeader,
                  leadConfigId: t.leadConfigId,
                  avatarUrl: t.avatarUrl,
                })
              }
            })
            console.log(`  API: 第 ${data.data.currentPage}/${data.data.totalPage} 页，累计 ${allTraders.length}`)
          }
        } catch (e) {}
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 加载超时')
    }
    await sleep(8000)

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*="close"]').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got it') || text.includes('×')) {
          try { btn.click() } catch (e) {}
        }
      })
    })
    await sleep(2000)

    // 滚动到分页区域
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)

    // 分页获取数据
    console.log('\n📄 分页获取数据...')
    
    for (let targetPage = 2; targetPage <= MAX_PAGES; targetPage++) {
      // 检查是否已经获取足够的符合条件的交易员
      const qualified = allTraders.filter(t => t.daysAsLeader >= config.minDays)
      if (qualified.length >= TARGET_COUNT) {
        console.log(`  ✓ 已获取 ${qualified.length} 个符合条件的交易员`)
        break
      }
      
      // 点击分页按钮
      const clicked = await page.evaluate((targetPage) => {
        // 点击页码按钮 (使用 data-current 属性)
        const btn = document.querySelector(`button[data-current="${targetPage}"]`)
        if (btn && !btn.disabled) {
          btn.click()
          return 'page-' + targetPage
        }
        // 如果找不到特定页码，点击下一页箭头
        const nextLi = document.querySelector('li.KuxPagination-item[data-item="next"]')
        if (nextLi) {
          const nextBtn = nextLi.querySelector('button:not([disabled])')
          if (nextBtn) {
            nextBtn.click()
            return 'next'
          }
        }
        return false
      }, targetPage)
      
      if (!clicked) {
        console.log('  无法翻页')
        break
      }
      
      await sleep(2500)
    }

    console.log(`\n📊 共获取 ${allTraders.length} 个交易员数据`)
    
    // 按天数筛选
    const filtered = allTraders.filter(t => t.daysAsLeader >= config.minDays)
    console.log(`  符合 >= ${config.minDays} 天条件: ${filtered.length} 个`)

  } finally {
    await browser.close()
  }

  // 筛选符合条件的交易员
  const filtered = allTraders.filter(t => t.daysAsLeader >= config.minDays)
  
  // 转换格式
  return filtered.map((t, idx) => ({
    traderId: t.leadConfigId,
    nickname: t.nickName,
    avatar: t.avatarUrl,
    roi: t.pnl30d ? t.pnl30d * 100 : 0, // 转换为百分比
    pnl: null,
    winRate: null,
    maxDrawdown: null,
    followers: null,
    daysAsLeader: t.daysAsLeader,
    rank: idx + 1,
  }))
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
        profile_url: trader.avatar,
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
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`KuCoin 数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`(days as lead >= ${PERIOD_CONFIG[period].minDays})`)
    console.log(`${'='.repeat(50)}`)
    
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到数据，跳过`)
      continue
    }

    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    traders.forEach((t, idx) => t.rank = idx + 1)

    const top100 = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top100.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}% (${t.daysAsLeader}天)`)
    })

    const result = await saveTraders(top100, period)
    results.push({ period, count: top100.length, topRoi: top100[0]?.roi || 0 })
    
    console.log(`\n✅ ${period} 完成！`)
    
    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 5 秒后抓取下一个时间段...`)
      await sleep(5000)
    }
  }
  
  const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ 全部完成！`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 抓取结果:`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.count} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
