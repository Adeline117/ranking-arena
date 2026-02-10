/**
 * BingX 合约跟单排行榜数据抓取 (Playwright 浏览器版)
 *
 * BingX 所有 API 端点受 Cloudflare 保护 (403)，使用 Playwright 浏览器抓取
 * 通过拦截页面内部 API 调用 + DOM 提取获取数据
 *
 * 用法: node scripts/import/import_bingx.mjs [7D|30D|90D|ALL]
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'bingx'
const BASE_URL = 'https://bingx.com/en/CopyTrading/leaderBoard'
const TARGET_COUNT = 500

const PERIOD_CONFIG = {
  '7D':  { tabTexts: ['7D', '7 Days', '7天', 'Last 7 Days'], timeRange: 7 },
  '30D': { tabTexts: ['30D', '30 Days', '30天', 'Last 30 Days'], timeRange: 30 },
  '90D': { tabTexts: ['90D', '90 Days', '90天', 'Last 90 Days'], timeRange: 90 },
}

async function fetchLeaderboard(browser, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n📋 抓取 BingX ${period} 排行榜...`)

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })

  const page = await context.newPage()
  const traders = new Map()

  // 拦截 API 响应
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copyTrad') && !url.includes('copy_trad') && !url.includes('trader') &&
        !url.includes('leaderBoard') && !url.includes('getTop') && !url.includes('ranking')) return

    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      let list = []
      if (json?.data?.list && Array.isArray(json.data.list)) list = json.data.list
      else if (json?.data?.rows && Array.isArray(json.data.rows)) list = json.data.rows
      else if (json?.data?.records && Array.isArray(json.data.records)) list = json.data.records
      else if (Array.isArray(json?.data)) list = json.data

      if (list.length > 0) {
        const endpoint = url.split('?')[0].split('/').slice(-3).join('/')
        console.log(`  📡 API 拦截 (${endpoint}): ${list.length} 条`)
        if (list[0]) console.log(`    样本字段: ${Object.keys(list[0]).slice(0, 12).join(', ')}`)

        for (const t of list) {
          const traderId = String(t.uniqueId || t.uid || t.traderId || t.id || '')
          if (!traderId || traderId === 'undefined' || traders.has(traderId)) continue

          let roi = parseFloat(String(t.roi || t.roiRate || t.returnRate || t.pnlRatio || 0))
          if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

          traders.set(traderId, {
            traderId,
            nickname: t.traderName || t.nickname || t.nickName || t.displayName || t.name || `Trader_${traderId.slice(0, 8)}`,
            avatarUrl: t.headUrl || t.avatar || t.avatarUrl || null,
            roi,
            pnl: parseFloat(String(t.pnl || t.totalPnl || t.profit || 0)),
            winRate: t.winRate != null ? parseFloat(String(t.winRate)) * (parseFloat(String(t.winRate)) <= 1 ? 100 : 1) : null,
            maxDrawdown: t.maxDrawdown != null ? parseFloat(String(t.maxDrawdown)) * (parseFloat(String(t.maxDrawdown)) <= 1 ? 100 : 1) : null,
            followers: parseInt(String(t.followerNum || t.followers || t.followerCount || 0)),
          })
        }
        console.log(`    累计: ${traders.size} 个`)
      }
    } catch (e) { /* ignore non-JSON */ }
  })

  try {
    console.log(`  导航到 ${BASE_URL}...`)
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {
      console.log('  ⚠ 页面加载超时，继续...')
    })
    await sleep(5000)

    const title = await page.title()
    console.log(`  页面标题: ${title}`)

    // 关闭弹窗
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'I understand', 'Confirm', "I don't live"]) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) {
        await btn.first().click().catch(() => {})
        await sleep(500)
      }
    }

    // 也尝试关闭模态框
    await page.evaluate(() => {
      document.querySelectorAll('[class*="modal"] [class*="close"], [class*="dialog"] [class*="close"], [class*="popup"] [class*="close"]').forEach(el => {
        try { el.click() } catch {}
      })
    }).catch(() => {})
    await sleep(2000)

    // 切换周期
    console.log(`  切换到 ${period} 周期...`)
    for (const txt of config.tabTexts) {
      const el = page.getByText(txt, { exact: true })
      if (await el.count() > 0) {
        await el.first().click().catch(() => {})
        console.log(`  ✓ 点击了 "${txt}"`)
        await sleep(3000)
        break
      }
    }

    console.log(`  API 拦截到: ${traders.size} 个`)

    // 滚动加载更多
    console.log(`  滚动加载更多数据...`)
    let lastSize = traders.size
    let stableCount = 0
    for (let i = 0; i < 30 && traders.size < TARGET_COUNT; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)

      // 尝试点击"加载更多"按钮
      const moreBtn = page.getByText(/Load More|加载更多|See More|查看更多/i)
      if (await moreBtn.count() > 0) {
        await moreBtn.first().click().catch(() => {})
        await sleep(2000)
      }

      // 尝试翻页
      const nextBtn = page.getByRole('button', { name: /next|下一页|›|»/i })
      if (await nextBtn.count() > 0 && await nextBtn.first().isEnabled()) {
        await nextBtn.first().click().catch(() => {})
        await sleep(2000)
      }

      if (traders.size === lastSize) {
        stableCount++
        if (stableCount >= 5) break
      } else {
        stableCount = 0
        lastSize = traders.size
      }

      if ((i + 1) % 5 === 0) console.log(`    滚动 ${i + 1}: ${traders.size} 个`)
    }

    // DOM 提取 fallback
    if (traders.size < 10) {
      console.log(`  从 DOM 提取数据...`)
      const pageData = await page.evaluate(() => {
        const results = []
        const seen = new Set()

        // 尝试各种卡片容器
        const cards = document.querySelectorAll(
          '[class*="trader"], [class*="card"], [class*="item"], [class*="lead"], [class*="rank"], [class*="user"]'
        )

        cards.forEach(card => {
          const text = card.innerText || ''
          if (!text.includes('%') || text.length > 2000 || text.length < 20) return

          const roiMatch = text.match(/([+-]?\d{1,5}(?:\.\d{1,2})?)\s*%/)
          if (!roiMatch) return
          const roi = parseFloat(roiMatch[1])
          if (roi === 0 || isNaN(roi)) return

          // 提取名字 (非数字、非按钮文字的短文本行)
          const lines = text.split('\n').filter(l => {
            const t = l.trim()
            return t && t.length > 1 && t.length < 30 && !t.includes('%') &&
              !t.match(/^\d/) && !t.includes('Copy') && !t.includes('Follow') &&
              !t.includes('ROI') && !t.includes('PnL')
          })
          const nickname = lines[0]?.trim() || ''
          if (!nickname) return

          const traderId = 'bingx_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
          if (!traderId || traderId === 'bingx_' || seen.has(traderId)) return
          seen.add(traderId)

          let winRate = null
          const wrMatch = text.match(/(?:Win|胜率)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
          if (wrMatch) winRate = parseFloat(wrMatch[1])

          let maxDrawdown = null
          const mddMatch = text.match(/(?:MDD|Drawdown|回撤|Max Draw)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
          if (mddMatch) maxDrawdown = parseFloat(mddMatch[1])

          results.push({ traderId, nickname, roi, winRate, maxDrawdown })
        })
        return results
      })

      for (const item of pageData) {
        if (!traders.has(item.traderId)) traders.set(item.traderId, item)
      }
      console.log(`  DOM 提取后: ${traders.size} 个`)
    }

    // 截图用于调试
    await page.screenshot({ path: `/tmp/bingx_${period}_${Date.now()}.png`, fullPage: false }).catch(() => {})
  } finally {
    await context.close()
  }

  return Array.from(traders.values()).slice(0, TARGET_COUNT)
}

async function saveTraders(traders, period) {
  if (traders.length === 0) { console.log('  ⚠ 无数据可保存'); return 0 }
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const topTraders = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  console.log(`\n💾 保存 ${topTraders.length} 条 ${period} 数据...`)

  await supabase.from('trader_sources').upsert(
    topTraders.map(t => ({
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: t.traderId,
      handle: t.nickname,
      avatar_url: t.avatarUrl || null,
      profile_url: `https://bingx.com/en/CopyTrading/tradeDetail/${t.traderId}`,
      is_active: true,
    })),
    { onConflict: 'source,source_trader_id' }
  )

  const { error } = await supabase.from('trader_snapshots').upsert(
    topTraders.map((t, idx) => ({
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl || null,
      win_rate: t.winRate,
      max_drawdown: t.maxDrawdown,
      followers: t.followers || null,
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
      captured_at: capturedAt,
    })),
    { onConflict: 'source,source_trader_id,season_id' }
  )

  if (error) {
    console.log(`  ⚠ upsert 失败: ${error.message}`)
    return 0
  }
  console.log(`  ✅ 保存成功: ${topTraders.length}`)
  return topTraders.length
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('BingX 数据抓取开始 (Playwright 浏览器模式)...')
  console.log(`周期: ${periods.join(', ')}`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    for (const period of periods) {
      const traders = await fetchLeaderboard(browser, period)
      console.log(`  📊 ${period}: 获取 ${traders.length} 个交易员`)
      if (traders.length > 0) await saveTraders(traders, period)
      if (periods.indexOf(period) < periods.length - 1) await sleep(3000)
    }
  } finally {
    await browser.close()
  }
  console.log('\n✅ BingX 完成')
}

main()
