/**
 * LBank Copy Trading 排行榜数据抓取
 *
 * URL: https://www.lbank.com/copy-trading
 *
 * LBank 没有公开 API，需要使用 Puppeteer 抓取页面数据
 *
 * 用法: node scripts/import/import_lbank.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'lbank'
const BASE_URL = 'https://www.lbank.com/copy-trading'
const TARGET_COUNT = 100
const MIN_COUNT = 20

// LBank 周期映射
const PERIOD_CONFIG = {
  '7D': { lbankPeriod: '7d', tabText: '7D', actualDays: 7 },
  '30D': { lbankPeriod: '30d', tabText: '30D', actualDays: 30 },
  '90D': { lbankPeriod: '90d', tabText: '90D', actualDays: 90 },
}

// Arena Score 计算逻辑
const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 85, MAX_DRAWDOWN_SCORE: 8, MAX_STABILITY_SCORE: 7,
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period, actualDays) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['30D']
  const days = actualDays || (period === '7D' ? 7 : period === '30D' ? 30 : 90)
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['30D']
}

async function fetchLeaderboard(browser, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n📋 抓取排行榜 (${period})...`)
  console.log(`  URL: ${BASE_URL}`)

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'zh-CN'] })
  })

  const traders = new Map()

  // 监听 API 响应
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('copy') || url.includes('trader') || url.includes('leader') || url.includes('ranking') || url.includes('follow')) {
      try {
        const contentType = response.headers()['content-type'] || ''
        if (!contentType.includes('json')) return

        const json = await response.json()
        let list = []

        if (json.data?.list && Array.isArray(json.data.list)) {
          list = json.data.list
        } else if (json.data?.traders && Array.isArray(json.data.traders)) {
          list = json.data.traders
        } else if (json.result?.list && Array.isArray(json.result.list)) {
          list = json.result.list
        } else if (Array.isArray(json.data)) {
          list = json.data
        } else if (json.rows && Array.isArray(json.rows)) {
          list = json.rows
        }

        if (list.length > 0) {
          console.log(`  📡 API 拦截: ${list.length} 条`)

          list.forEach((item) => {
            const traderId = String(item.uid || item.userId || item.traderId || item.id || item.memberId || '')
            if (!traderId || traderId === 'undefined' || traders.has(traderId)) return

            let roi = parseFloat(String(item.roi || item.returnRate || item.profitRate || item.yield || 0))
            if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

            const winRate = item.winRate !== undefined ? parseFloat(String(item.winRate || item.winRatio || 0)) : null
            const maxDrawdown = item.maxDrawdown !== undefined ? parseFloat(String(item.maxDrawdown || item.mdd || 0)) : null

            traders.set(traderId, {
              traderId,
              nickname: item.nickname || item.nickName || item.name || item.userName || `Trader_${traderId.slice(0, 8)}`,
              avatar: item.avatar || item.headUrl || item.avatarUrl || item.photo || null,
              roi,
              pnl: parseFloat(String(item.pnl || item.profit || item.totalProfit || item.totalPnl || 0)),
              winRate,
              maxDrawdown,
              followers: parseInt(String(item.followerCount || item.followers || item.copyCount || item.followNum || 0)),
            })
          })
          console.log(`    累计: ${traders.size} 个`)
        }
      } catch (e) {
        // 忽略非 JSON 响应
      }
    }
  })

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 90000 })
    await sleep(5000)

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, [role="button"], [class*="close"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (text.includes('ok') || text.includes('got') || text.includes('accept') ||
            text.includes('confirm') || text.includes('close') || text.includes('i understand')) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)

    // 点击周期选择标签
    console.log(`  切换到 ${config.tabText} 周期...`)
    const clickedPeriod = await page.evaluate((tabText) => {
      const tabs = document.querySelectorAll('button, [role="tab"], span, div, a')
      for (const tab of tabs) {
        const text = (tab.textContent || '').trim()
        if (text === tabText || text.includes(tabText)) {
          try {
            tab.click()
            return true
          } catch {}
        }
      }
      return false
    }, config.tabText)

    if (clickedPeriod) {
      console.log(`  ✓ 切换成功`)
      await sleep(3000)
    }

    console.log(`  API 拦截到: ${traders.size} 个`)

    // 从 DOM 提取数据
    if (traders.size < MIN_COUNT) {
      console.log(`  从 DOM 提取数据...`)

      const pageData = await page.evaluate(() => {
        const results = []
        const seen = new Set()

        // 查找交易员卡片 - LBank 可能使用不同的 class 命名
        const selectors = [
          '[class*="trader"]',
          '[class*="card"]',
          '[class*="item"]',
          '[class*="leader"]',
          '[class*="copy"]',
        ]

        for (const selector of selectors) {
          document.querySelectorAll(selector).forEach(card => {
            const text = card.innerText || ''
            if (!text.includes('%') || text.length > 2000 || text.length < 30) return

            // 提取 ROI
            const roiMatch = text.match(/([+-]?\d{1,5}(?:\.\d{1,2})?)\s*%/)
            if (!roiMatch) return
            const roi = parseFloat(roiMatch[1])
            if (roi === 0 || isNaN(roi)) return

            // 提取昵称
            const lines = text.split('\n').filter(l => {
              const t = l.trim()
              return t && t.length > 1 && t.length < 30 &&
                     !t.includes('%') && !t.match(/^\d/) && !t.includes('Copy') && !t.includes('Follow')
            })
            const nickname = lines[0]?.trim() || ''
            if (!nickname) return

            const traderId = 'lbank_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
            if (!traderId || traderId === 'lbank_' || seen.has(traderId)) return
            seen.add(traderId)

            // 提取胜率
            let winRate = null
            const wrMatch = text.match(/(?:Win|胜率)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
            if (wrMatch) winRate = parseFloat(wrMatch[1])

            // 提取回撤
            let maxDrawdown = null
            const mddMatch = text.match(/(?:MDD|DD|回撤|Drawdown)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
            if (mddMatch) maxDrawdown = parseFloat(mddMatch[1])

            results.push({
              traderId,
              nickname,
              roi,
              winRate,
              maxDrawdown,
            })
          })
        }

        return results
      })

      for (const item of pageData) {
        if (!traders.has(item.traderId)) {
          traders.set(item.traderId, item)
        }
      }
      console.log(`  DOM 提取后: ${traders.size} 个`)
    }

    // 滚动加载更多
    if (traders.size < TARGET_COUNT) {
      console.log(`  滚动加载更多...`)
      for (let i = 0; i < 10; i++) {
        if (traders.size >= TARGET_COUNT) break

        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight || 10000)
        })
        await sleep(2000)

        await page.evaluate(() => {
          document.querySelectorAll('button').forEach(btn => {
            const text = (btn.textContent || '').toLowerCase()
            if (text.includes('load more') || text.includes('more') || text.includes('加载更多') || text.includes('查看更多')) {
              try { btn.click() } catch {}
            }
          })
        }).catch(() => {})

        console.log(`    滚动 ${i + 1}: ${traders.size} 个`)
      }
    }

    await page.screenshot({ path: `/tmp/lbank_${period}_${Date.now()}.png`, fullPage: true })

  } finally {
    await page.close()
  }

  return Array.from(traders.values()).slice(0, TARGET_COUNT)
}

async function saveTradersBatch(traders, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n💾 批量保存 ${traders.length} 条数据...`)

  const capturedAt = new Date().toISOString()
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: t.avatar || null,
    is_active: true,
  }))

  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  const snapshotsData = traders.map((t, idx) => {
    const normalizedWr = t.winRate !== null ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate) : null
    const arenaScore = calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, normalizedWr, period, config.actualDays)

    if (idx < 5) {
      console.log(`    ${idx + 1}. ${(t.nickname || '').slice(0, 15)}: ROI ${t.roi?.toFixed(2)}% → Score ${arenaScore}`)
    }

    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl || null,
      win_rate: normalizedWr,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })

  const { error } = await supabase.from('trader_snapshots').insert(snapshotsData)

  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').insert(s)
      if (!e) saved++
    }
    return saved
  }

  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`LBank Copy Trading 数据抓取`)
  console.log(`${'='.repeat(50)}`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`${'='.repeat(50)}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--window-size=1920,1080',
    ],
  })

  const results = []

  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 开始抓取 ${period} 排行榜...`)
      console.log(`${'='.repeat(50)}`)

      const traders = await fetchLeaderboard(browser, period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到交易员列表，跳过`)
        continue
      }

      traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2) || 0}%`)
      })

      const saved = await saveTradersBatch(traders, period)
      results.push({ period, count: traders.length, saved, topRoi: traders[0]?.roi || 0 })

      console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)

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
      console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed?.(2) || r.topRoi}%`)
    }
    console.log(`   总耗时: ${totalTime}s`)
    console.log(`${'='.repeat(60)}`)

  } finally {
    await browser.close()
  }
}

main().catch(console.error)
