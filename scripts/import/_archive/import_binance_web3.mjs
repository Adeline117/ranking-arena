/**
 * Binance Web3 排行榜数据抓取
 * 
 * 使用 Playwright 抓取 Binance Web3 链上排行榜
 * 
 * 用法: node scripts/import_binance_web3.mjs [7D|30D|90D]
 * 
 * 数据源: https://web3.binance.com/zh-CN/leaderboard?chain=bsc
 */

import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'binance_web3'
const BASE_URL = 'https://web3.binance.com/zh-CN/leaderboard?chain=bsc'

const PERIOD_CONFIG = {
  '7D': { tabTexts: ['7天', '7 Days', '7D', '7日'], urlParam: '7d' },
  '30D': { tabTexts: ['30天', '30 Days', '30D', '1月', '一月'], urlParam: '30d' },
  '90D': { tabTexts: ['90天', '90 Days', '90D', '3月', '三月'], urlParam: '90d' },
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Binance Web3 ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log('URL:', BASE_URL)

  const traders = new Map()
  const apiResponses = []

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
  })

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      window.chrome = { runtime: {} }
    })

    const page = await context.newPage()
    const config = PERIOD_CONFIG[period]

    // 监听 API 响应 - 寻找包含钱包地址的 trader 数据
    page.on('response', async (response) => {
      const url = response.url()
      // 匹配 KOL、trader、user、wallet 相关的 API
      if (url.includes('kol') || url.includes('trader') || url.includes('user') ||
          url.includes('wallet') || url.includes('ranking') || url.includes('leader')) {
        try {
          const json = await response.json()
          const checkList = (list) => {
            // 检查是否是 trader 数据（包含钱包地址或 ROI）
            if (Array.isArray(list) && list.length > 0) {
              const first = list[0]
              const hasAddress = Object.values(first).some(v =>
                typeof v === 'string' && v.match(/^0x[a-fA-F0-9]{8,}/)
              )
              const hasRoi = Object.keys(first).some(k =>
                k.toLowerCase().includes('roi') || k.toLowerCase().includes('pnl') ||
                k.toLowerCase().includes('rate') || k.toLowerCase().includes('return')
              )
              return hasAddress || hasRoi
            }
            return false
          }

          if (json.data && checkList(json.data)) {
            console.log(`  📡 拦截到 trader API: ${json.data.length} 条数据 (${url.slice(-50)})`)
            apiResponses.push({ url, list: json.data })
          } else if (json.list && checkList(json.list)) {
            console.log(`  📡 拦截到 trader API: ${json.list.length} 条数据 (${url.slice(-50)})`)
            apiResponses.push({ url, list: json.list })
          }
        } catch (e) {}
      }
    })

    console.log('📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(5000)

    // 关闭可能的弹窗
    console.log('🔲 关闭弹窗...')
    for (let attempt = 0; attempt < 3; attempt++) {
      // 按 Escape 键关闭弹窗
      await page.keyboard.press('Escape')
      await sleep(500)
    }
    await sleep(1000)

    // 尝试点击时间周期 tab
    console.log(`🔄 切换到 ${period} 时间周期...`)
    for (const tabText of config.tabTexts) {
      try {
        const selectors = [
          `button:has-text("${tabText}")`,
          `[role="tab"]:has-text("${tabText}")`,
          `div:has-text("${tabText}")`,
          `span:has-text("${tabText}")`,
        ]
        for (const selector of selectors) {
          const element = await page.$(selector)
          if (element) {
            await element.click()
            console.log(`  ✓ 点击成功: "${tabText}"`)
            await sleep(3000)
            break
          }
        }
      } catch (e) {}
    }

    // 尝试点击排序按钮 - 按 ROI 从高到低排序
    console.log('📊 尝试按 ROI 排序...')
    await page.evaluate(() => {
      // 查找包含 ROI/收益率/回报率 的列标题或排序按钮
      const sortKeywords = ['ROI', '收益率', '回报率', '盈亏', 'PnL', 'Return', '收益', '涨幅']
      const clickables = document.querySelectorAll('th, [class*="sort"], [class*="header"] div, button')

      for (const el of clickables) {
        const text = el.innerText || el.textContent || ''
        if (sortKeywords.some(kw => text.includes(kw))) {
          try {
            el.click()
            console.log('  点击排序: ' + text.slice(0, 20))
          } catch (e) {}
          break
        }
      }
    })
    await sleep(2000)

    // 滚动加载更多数据
    console.log('📜 滚动加载更多数据...')
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await sleep(800)

      // 尝试点击"加载更多"按钮
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"]')
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase()
          if (text.includes('more') || text.includes('加载') || text.includes('更多')) {
            try { btn.click() } catch (e) {}
          }
        }
      })
    }
    await sleep(2000)

    // 处理 API 响应
    console.log(`\n📊 处理 ${apiResponses.length} 个 API 响应...`)
    for (const { list } of apiResponses) {
      // 调试：打印第一条数据的结构
      if (list.length > 0) {
        console.log('  📋 第一条数据字段:', Object.keys(list[0]).join(', '))
        console.log('  📋 第一条数据示例:', JSON.stringify(list[0]).slice(0, 500))
      }

      list.forEach((item, idx) => {
        // 尝试更多可能的字段名
        const traderId = String(
          item.address || item.wallet || item.walletAddress ||
          item.id || item.userId || item.user_id ||
          item.traderAddress || item.trader_address ||
          item.account || item.accountAddress || ''
        )
        if (!traderId) {
          if (idx === 0) console.log('  ⚠ 无法提取 traderId，可用字段:', Object.keys(item).join(', '))
          return
        }

        const existing = traders.get(traderId)
        // 尝试更多可能的 ROI 字段名，处理百分比格式
        let roi = item.roi ?? item.pnlPct ?? item.returnRate ?? item.pnlRate ??
                  item.return_rate ?? item.profit_rate ?? item.profitRate ??
                  item.roiRate ?? item.pnl_pct ?? item.totalPnlRate ?? 0
        // 如果 ROI 是小数形式（如 0.5 表示 50%），转换为百分比
        if (typeof roi === 'number' && Math.abs(roi) < 10) {
          roi = roi * 100
        }
        roi = parseFloat(roi)

        if (!existing || roi > existing.roi) {
          traders.set(traderId, {
            traderId,
            nickname: item.name || item.nickname || item.displayName || item.userName || traderId.slice(0, 10) + '...',
            avatar: item.avatar || item.avatarUrl || item.profileImage || null,
            roi,
            pnl: parseFloat(item.pnl ?? item.profit ?? item.totalPnl ?? item.total_pnl ?? 0),
            winRate: parseFloat(item.winRate ?? item.win_rate ?? item.successRate ?? 0),
            maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? item.max_drawdown ?? 0),
            followers: parseInt(item.followers ?? item.followerCount ?? 0),
            rank: idx + 1,
          })
        }
      })
    }

    // 从 DOM 提取数据
    console.log('📊 从页面 DOM 提取数据...')

    // 先打印一些调试信息
    const debugInfo = await page.evaluate(() => {
      const text = document.body.innerText
      const lines = text.split('\n').filter(l => l.includes('0x'))
      return {
        totalLines: text.split('\n').length,
        linesWithAddr: lines.length,
        sampleLines: lines.slice(0, 5),
      }
    })
    console.log(`  📋 页面总行数: ${debugInfo.totalLines}, 包含 0x 的行: ${debugInfo.linesWithAddr}`)
    if (debugInfo.sampleLines.length > 0) {
      console.log('  📋 示例行:')
      debugInfo.sampleLines.forEach((line, i) => {
        console.log(`     ${i + 1}. ${line.slice(0, 100)}`)
      })
    }

    const pageTraders = await page.evaluate(() => {
      const results = []
      const seen = new Set()

      // 方法1: 查找表格行元素，每行包含多个单元格
      const rows = document.querySelectorAll('tr, [class*="row"], [class*="item"], [class*="list"] > div')

      rows.forEach(row => {
        const rowText = row.innerText || ''
        if (!rowText.includes('0x')) return
        // 跳过表头行
        if (rowText.includes('地址') && rowText.includes('BNB')) return

        // 匹配地址
        const addrMatch = rowText.match(/0x([a-fA-F0-9]{4,8})[\.…]{1,3}([a-fA-F0-9]{4,8})/) ||
                          rowText.match(/0x([a-fA-F0-9]{40})/) ||
                          rowText.match(/0x([a-fA-F0-9]{6,})/)

        if (!addrMatch) return

        const traderId = addrMatch[0]
        if (seen.has(traderId)) return
        seen.add(traderId)

        // 在整行文本中查找所有百分比 - 排除阈值类文本 (>500%, <50% 等)
        const percentages = []
        // 匹配纯数字百分比，不带 > 或 < 前缀
        const roiMatches = rowText.matchAll(/(?<![><])(\d{1,5}(?:\.\d{1,2})?)\s*%/g)
        for (const match of roiMatches) {
          const val = parseFloat(match[1])
          // 过滤掉常见的阈值值 (500, 50, 0 等) 和过大的值
          if (!isNaN(val) && val > 0.1 && val < 50000 && val !== 500 && val !== 50) {
            percentages.push(val)
          }
        }

        // 取最大的百分比作为 ROI（如果没有有效百分比则跳过）
        const roi = percentages.length > 0 ? Math.max(...percentages) : null

        // 提取昵称
        let nickname = traderId.slice(0, 10) + '...'
        const nicknameMatch = rowText.match(/[\u4e00-\u9fa5a-zA-Z◆][\u4e00-\u9fa5a-zA-Z0-9_\-\s◆|]{1,20}/)
        if (nicknameMatch && !nicknameMatch[0].includes('0x') && !nicknameMatch[0].includes('地址')) {
          nickname = nicknameMatch[0].trim()
        }

        if (roi !== null) {
          results.push({
            traderId,
            nickname,
            avatar: null,
            roi,
            pnl: null,
            winRate: null,
            maxDrawdown: null,
            followers: null,
            rank: results.length + 1,
          })
        }
      })

      // 方法2: 如果方法1没找到，尝试从整个表格区域提取
      if (results.length === 0) {
        // 查找可能的表格容器
        const tableContainers = document.querySelectorAll('[class*="table"], [class*="list"], [class*="leaderboard"]')

        tableContainers.forEach(container => {
          const text = container.innerText || ''
          // 按换行符分割，找到每个交易员的数据块
          const blocks = text.split(/\n{2,}/)  // 两个或更多换行分隔块

          blocks.forEach(block => {
            if (!block.includes('0x')) return

            const addrMatch = block.match(/0x([a-fA-F0-9]{4,})[\.…]*([a-fA-F0-9]*)/)
            if (!addrMatch) return

            const traderId = addrMatch[0]
            if (seen.has(traderId)) return
            seen.add(traderId)

            // 查找百分比
            const percentages = []
            const matches = block.matchAll(/(\d{1,5}(?:\.\d{1,2})?)\s*%/g)
            for (const match of matches) {
              const val = parseFloat(match[1])
              if (!isNaN(val) && val > 0 && val < 100000) {
                percentages.push(val)
              }
            }

            const roi = percentages.length > 0 ? Math.max(...percentages) : null

            if (roi !== null) {
              results.push({
                traderId,
                nickname: traderId.slice(0, 10) + '...',
                avatar: null,
                roi,
                pnl: null,
                winRate: null,
                maxDrawdown: null,
                followers: null,
                rank: results.length + 1,
              })
            }
          })
        })
      }

      return results
    })

    console.log(`  📋 DOM 提取到 ${pageTraders.length} 个交易员`)

    // 打印前3个的详情用于调试
    if (pageTraders.length > 0) {
      console.log('  📋 示例数据:')
      pageTraders.slice(0, 3).forEach((t, i) => {
        console.log(`     ${i + 1}. ${t.traderId}: ROI ${t.roi}%`)
      })
    }

    pageTraders.forEach(t => {
      if (!traders.has(t.traderId)) traders.set(t.traderId, t)
    })

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    if (traders.size === 0) {
      const screenshotPath = `/tmp/binance_web3_${period}_${Date.now()}.png`
      await page.screenshot({ path: screenshotPath, fullPage: true })
      console.log(`  📸 截图保存到: ${screenshotPath}`)
    }
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
      await supabase.from('trader_sources').insert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        avatar_url: trader.avatar || null,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const normalizedWr = trader.winRate !== null ? (trader.winRate <= 1 ? trader.winRate * 100 : trader.winRate) : null
      const { error } = await supabase.from('trader_snapshots').upsert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: normalizedWr,
        max_drawdown: trader.maxDrawdown,
        followers: trader.followers || 0,
        arena_score: calculateArenaScore(trader.roi, trader.pnl, trader.maxDrawdown, normalizedWr, period).totalScore,
        captured_at: capturedAt,
      }, { onConflict: 'source,source_trader_id,season_id' })

      if (error) errors++
      else saved++
    } catch (error) {
      errors++
    }
  }

  console.log(`  ✓ 保存成功: ${saved}`)
  if (errors > 0) console.log(`  ✗ 保存失败: ${errors}`)

  return { saved, errors }
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Binance Web3 排行榜数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`========================================`)

  const results = []

  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 开始抓取 ${period} 排行榜...`)
      console.log(`${'='.repeat(50)}`)
      
      const traders = await fetchLeaderboardData(period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到任何数据，跳过`)
        continue
      }

      traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
      traders.forEach((t, idx) => t.rank = idx + 1)

      console.log(`\n📋 ${period} TOP 10:`)
      traders.slice(0, 10).forEach((t, idx) => {
        console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
      })

      const result = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved: result.saved, topRoi: traders[0]?.roi || 0 })
      
      console.log(`\n✅ ${period} 完成！保存了 ${result.saved} 条数据`)
      
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
      console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
    }
    console.log(`   总耗时: ${totalTime}s`)
    console.log(`${'='.repeat(60)}`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
  }
}

main()
