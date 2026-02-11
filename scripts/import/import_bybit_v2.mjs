#!/usr/bin/env node
/**
 * Bybit Copy Trading 排行榜数据抓取 v2
 * 
 * 改进点:
 * 1. 点击 "All Traders" 获取全部交易员（不只是推荐）
 * 2. 正确选择时间筛选 (7D/30D/90D)
 * 3. 改进翻页/滚动逻辑
 * 4. 使用 API 拦截 + DOM 提取双重策略
 * 
 * 用法: node scripts/import/import_bybit_v2.mjs [7D|30D|90D]
 */

import { config } from 'dotenv'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: join(__dirname, '../../.env.local') })

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { sb } from './lib/index.mjs'

puppeteer.use(StealthPlugin())

const SOURCE = 'bybit'
// Bybit Copy Trading 页面 - 使用 find 子页面可以看到全部交易员
const BASE_URL = 'https://www.bybit.com/copyTrade/trade-center/find'
const TARGET_COUNT = 500
const PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890'

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period = '30D') {
  const periodMultiplier = { '7D': 0.7, '30D': 1.0, '90D': 1.3 }[period] || 1.0
  const roiScore = Math.min(100, Math.max(0, roi / 10)) * 0.5
  const wrScore = (winRate || 50) * 0.003
  const ddPenalty = Math.min(30, (maxDrawdown || 0) * 0.3) * 0.01
  return Math.round((roiScore + wrScore - ddPenalty) * periodMultiplier * 100) / 100
}

async function fetchLeaderboardData(period) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 抓取 Bybit ${period} 排行榜`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标: ${TARGET_COUNT} 个交易员`)
  console.log(`${'='.repeat(60)}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--proxy-server=${PROXY}`,
    ],
    timeout: 90000,
  })

  const allTraders = new Map()

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    )
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      // Bybit API patterns
      if (url.includes('leader') || url.includes('master') || url.includes('copyTrade')) {
        try {
          const contentType = response.headers()['content-type'] || ''
          if (!contentType.includes('json')) return
          
          const json = await response.json()
          const list = extractListFromResponse(json)
          
          if (list.length > 0) {
            console.log(`  📡 API 拦截: ${list.length} 条 (${url.split('?')[0].split('/').pop()})`)
            
            for (const item of list) {
              const trader = parseTraderFromAPI(item)
              if (trader && !allTraders.has(trader.traderId)) {
                allTraders.set(trader.traderId, trader)
              }
            }
          }
        } catch {}
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠️ 页面加载超时，继续处理...')
    }
    await sleep(5000)

    // 关闭弹窗
    console.log('🔄 关闭弹窗...')
    await closePopups(page)
    await sleep(2000)

    // 截图查看页面状态
    await page.screenshot({ path: `/tmp/bybit_v2_1_initial.png` })

    // 1. 点击 "All Traders" / "All Leaders" 选项
    console.log('\n🔄 点击 "All Traders" 选项...')
    const clickedAllTraders = await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"], button, div[class*="tab"]')
      for (const tab of tabs) {
        const text = (tab.textContent || '').toLowerCase().trim()
        if (text.includes('all') && (text.includes('trader') || text.includes('leader') || text.includes('master'))) {
          tab.click()
          return text
        }
      }
      // 也尝试匹配中文
      for (const tab of tabs) {
        const text = (tab.textContent || '').trim()
        if (text.includes('全部') || text.includes('所有')) {
          tab.click()
          return text
        }
      }
      return null
    })
    
    if (clickedAllTraders) {
      console.log(`  ✓ 点击了: "${clickedAllTraders}"`)
    } else {
      console.log('  ⚠️ 未找到 "All Traders" 选项')
    }
    await sleep(3000)

    // 2. 选择时间周期
    console.log(`\n🔄 选择时间周期: ${period}...`)
    const periodValue = period.replace('D', '')
    const clickedPeriod = await page.evaluate((days) => {
      const options = document.querySelectorAll('button, div, span, [role="option"], [role="tab"]')
      for (const opt of options) {
        const text = (opt.textContent || '').trim()
        // 匹配 "7D", "30D", "90D", "7 Days", "30 Days", "7天" 等
        if (
          text === `${days}D` ||
          text === `${days} Days` ||
          text === `${days}天` ||
          text === days ||
          text.toLowerCase() === `${days}d`
        ) {
          opt.click()
          return text
        }
      }
      return null
    }, periodValue)

    if (clickedPeriod) {
      console.log(`  ✓ 选择了: "${clickedPeriod}"`)
    } else {
      console.log(`  ⚠️ 未找到 ${period} 选项`)
    }
    await sleep(3000)

    // 3. 点击 ROI 排序
    console.log('\n🔄 点击 ROI 排序...')
    await page.evaluate(() => {
      const headers = document.querySelectorAll('th, [class*="header"], [class*="sort"]')
      for (const h of headers) {
        const text = (h.textContent || '').toLowerCase()
        if (text.includes('roi') || text.includes('return')) {
          h.click()
          return true
        }
      }
      return false
    })
    await sleep(2000)

    // 截图
    await page.screenshot({ path: `/tmp/bybit_v2_2_after_filters.png` })

    console.log(`\n📊 API 拦截到: ${allTraders.size} 个交易员`)

    // 4. 滚动加载更多数据
    console.log('\n📜 滚动加载更多数据...')
    let lastCount = allTraders.size
    let noNewDataCount = 0

    for (let i = 1; i <= 50; i++) {
      // 滚动
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(1500)

      const currentCount = allTraders.size
      
      if (i % 5 === 0) {
        console.log(`  滚动 ${i}: ${currentCount} 个交易员`)
      }

      // 检查是否有新数据
      if (currentCount === lastCount) {
        noNewDataCount++
        if (noNewDataCount >= 5) {
          console.log(`  📍 连续 5 次无新数据，尝试点击加载更多...`)
          
          // 尝试点击"加载更多"按钮
          const clickedMore = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, div[class*="more"], span[class*="more"]')
            for (const btn of buttons) {
              const text = (btn.textContent || '').toLowerCase()
              if (text.includes('more') || text.includes('load') || text.includes('加载') || text.includes('查看更多')) {
                btn.click()
                return true
              }
            }
            return false
          })
          
          if (clickedMore) {
            console.log('  ✓ 点击了加载更多')
            await sleep(3000)
            noNewDataCount = 0
          } else if (noNewDataCount >= 10) {
            console.log('  📍 无法获取更多数据，停止滚动')
            break
          }
        }
      } else {
        noNewDataCount = 0
      }

      lastCount = currentCount

      if (allTraders.size >= TARGET_COUNT) {
        console.log(`  ✓ 已达到目标数量: ${TARGET_COUNT}`)
        break
      }
    }

    console.log(`\n📊 滚动后共有: ${allTraders.size} 个交易员`)

    // 5. 如果 API 数据不够，从 DOM 提取
    if (allTraders.size < 50) {
      console.log('\n🔍 从 DOM 提取数据...')
      const domTraders = await extractFromDOM(page)
      console.log(`  DOM 提取: ${domTraders.length} 个`)
      
      for (const t of domTraders) {
        if (t.traderId && !allTraders.has(t.traderId)) {
          allTraders.set(t.traderId, t)
        }
      }
    }

    // 最终截图
    await page.screenshot({ path: `/tmp/bybit_v2_3_final.png`, fullPage: true })
    console.log(`\n📊 总共获取: ${allTraders.size} 个交易员`)

  } finally {
    await browser.close()
  }

  return Array.from(allTraders.values())
}

function extractListFromResponse(json) {
  if (!json) return []

  // 常见的 API 响应结构
  const paths = [
    json?.result?.leaderDetails,
    json?.result?.list,
    json?.result?.rows,
    json?.result?.data,
    json?.data?.leaderDetails,
    json?.data?.list,
    json?.data?.rows,
    json?.list,
    json?.rows,
  ]

  for (const list of paths) {
    if (Array.isArray(list) && list.length > 0) {
      // 验证是否包含交易员数据
      const first = list[0]
      if (first && (first.leaderMark || first.leaderId || first.uid || first.roi || first.roiValue)) {
        return list
      }
    }
  }

  return []
}

function parseTraderFromAPI(item) {
  const traderId = String(
    item.leaderMark || item.leaderId || item.leaderUserId || item.uid || item.id || ''
  )

  if (!traderId || traderId.length < 3) return null

  const nickname = item.nickName || item.nickname || item.displayName || item.name || null

  // 解析 ROI
  let roi = 0
  if (item.metricValues && Array.isArray(item.metricValues)) {
    // metricValues[0] 通常是 ROI
    roi = parsePercent(item.metricValues[0])
  } else {
    roi = parsePercent(item.roi) || parsePercent(item.roiValue) || parsePercent(item.profitRate) || 0
  }

  if (roi === 0) return null

  // 解析其他指标
  let maxDrawdown = 0
  let pnl = 0
  let winRate = 0

  if (item.metricValues && Array.isArray(item.metricValues)) {
    maxDrawdown = parsePercent(item.metricValues[1]) || 0
    pnl = parseNumber(item.metricValues[2]) || 0
    winRate = parsePercent(item.metricValues[3]) || 0
  } else {
    maxDrawdown = parsePercent(item.maxDrawdown) || parsePercent(item.mdd) || 0
    pnl = parseNumber(item.pnl) || parseNumber(item.totalProfit) || 0
    winRate = parsePercent(item.winRate) || parsePercent(item.winRatio) || 0
  }

  const followers = parseInt(item.followerNum || item.followers || item.copierNum || item.currentFollowerCount || 0)
  const avatar = item.profilePhoto || item.avatar || item.avatarUrl || null

  return {
    traderId,
    nickname,
    avatar,
    roi: Math.abs(roi) > 0 && Math.abs(roi) < 10 ? roi * 100 : roi, // 如果是小数则转百分比
    pnl,
    winRate: winRate > 0 && winRate <= 1 ? winRate * 100 : winRate,
    maxDrawdown: Math.abs(maxDrawdown),
    followers,
  }
}

function parsePercent(val) {
  if (!val) return 0
  const str = String(val).replace(/[,%]/g, '')
  const num = parseFloat(str)
  return isNaN(num) ? 0 : num
}

function parseNumber(val) {
  if (!val) return 0
  const str = String(val).replace(/[^0-9.\-]/g, '')
  const num = parseFloat(str)
  return isNaN(num) ? 0 : num
}

async function closePopups(page) {
  await page.evaluate(() => {
    // 关闭常见弹窗
    const closeTexts = ["don't live", 'confirm', 'got it', 'close', 'ok', 'accept', 'i understand', '知道了', '确认']
    document.querySelectorAll('button, div, span').forEach((el) => {
      const text = (el.textContent || '').toLowerCase().trim()
      if (closeTexts.some(t => text.includes(t))) {
        try { el.click() } catch {}
      }
    })
    // 关闭模态框
    document.querySelectorAll('[class*="modal"] [class*="close"], [class*="dialog"] [class*="close"]').forEach(el => {
      try { el.click() } catch {}
    })
  })
}

async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const results = []
    const seen = new Set()

    // 查找交易员卡片
    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="leader"], [class*="item"]')

    cards.forEach(card => {
      const text = card.innerText || ''
      if (text.length < 20) return

      // 提取 trader ID
      const link = card.querySelector('a[href*="leader"], a[href*="trader"]')
      const href = link?.getAttribute('href') || ''
      const idMatch = href.match(/leaderMark=([^&]+)/) || href.match(/\/([A-Za-z0-9]+)$/)
      let traderId = idMatch?.[1]

      // 如果没有链接，尝试从数据属性获取
      if (!traderId) {
        traderId = card.getAttribute('data-id') || card.getAttribute('data-leader-id')
      }

      // 提取名字作为备用 ID
      const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
      const name = nameEl?.textContent?.trim()
      
      if (!traderId && name) {
        traderId = name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
      }

      if (!traderId || seen.has(traderId)) return
      seen.add(traderId)

      // 提取 ROI
      const roiMatches = text.match(/([+-]?\d{1,4}(?:\.\d+)?)\s*%/g)
      let roi = null
      if (roiMatches) {
        for (const match of roiMatches) {
          const val = parseFloat(match.replace(/[^0-9.\-+]/g, ''))
          if (Math.abs(val) > 1 && (roi === null || Math.abs(val) > Math.abs(roi))) {
            roi = val
          }
        }
      }

      if (roi === null || roi === 0) return

      // 提取头像
      const img = card.querySelector('img')
      const avatar = img?.src || null

      results.push({
        traderId,
        nickname: name || null,
        avatar,
        roi,
        pnl: 0,
        winRate: 0,
        maxDrawdown: 0,
        followers: 0,
      })
    })

    return results
  })
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员到数据库...`)

  const capturedAt = new Date().toISOString()

  // 保存 trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    is_active: true,
  }))

  await sb
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  // 保存 trader_snapshots
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi || 0,
    pnl: t.pnl || null,
    win_rate: t.winRate || null,
    max_drawdown: t.maxDrawdown || null,
    followers: t.followers || null,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period),
    captured_at: capturedAt,
  }))

  const { error } = await sb
    .from('trader_snapshots')
    .upsert(snapshotsData, { onConflict: 'source,source_trader_id,season_id' })

  if (error) {
    console.log(`  ⚠️ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await sb
        .from('trader_snapshots')
        .upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }

  console.log(`  ✅ 成功保存 ${snapshotsData.length} 条记录`)
  return snapshotsData.length
}

async function main() {
  const args = process.argv.slice(2)
  let periods = ['30D']
  
  if (args.length > 0) {
    if (args[0].toUpperCase() === 'ALL') {
      periods = ['7D', '30D', '90D']
    } else {
      periods = args.map(a => a.toUpperCase())
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bybit 数据抓取 v2`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`${'='.repeat(60)}`)

  const results = []

  for (const period of periods) {
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log(`\n⚠️ ${period} 未获取到数据`)
      continue
    }

    // 按 ROI 排序
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    const top = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const saved = await saveTraders(top, period)
    results.push({ period, count: traders.length, saved, topRoi: top[0]?.roi || 0 })
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ 完成!`)
  console.log(`${'='.repeat(60)}`)
  for (const r of results) {
    console.log(`  ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
}

main().catch(console.error)
