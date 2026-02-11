/**
 * Weex Copy Trading 排行榜数据抓取
 *
 * Uses Puppeteer to bypass CF, then calls internal APIs from within the browser:
 * - /api/v1/public/trace/topTraderListView (top traders by category)
 * - /api/v1/public/trace/traderListView (paginated list with sort rules)
 * - /api/v1/public/trace/sortConditionList (available sort rules)
 *
 * All 3 periods (7D/30D/90D) use the same trader pool since Weex
 * only has 3-week and all-time data.
 *
 * 用法: node scripts/import/import_weex.mjs [7D|30D|90D|ALL]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())

const supabase = getSupabaseClient()
const SOURCE = 'weex'

function parseTrader(item) {
  const traderId = String(item.traderUserId || item.traderId || item.uid || item.id || '')
  if (!traderId || traderId === 'undefined') return null

  let roi = 0
  // totalReturnRate is already percentage (e.g. 113.24 = 113.24%)
  if (item.totalReturnRate != null) roi = parseFloat(String(item.totalReturnRate))
  // ndaysReturnRates array
  if (roi === 0 && Array.isArray(item.ndaysReturnRates)) {
    const r = item.ndaysReturnRates.find(x => x.ndays === 21) ||
              item.ndaysReturnRates.find(x => x.ndays === 7) ||
              item.ndaysReturnRates[item.ndaysReturnRates.length - 1]
    if (r?.rate != null) roi = parseFloat(r.rate)
  }
  if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

  const pnl = parseFloat(String(item.threeWeeksPNL || item.profit || item.totalProfit || 0))
  const followers = parseInt(String(item.followCount || item.followerCount || item.copierCount || 0))

  return {
    traderId,
    nickname: item.traderNickName || item.nickName || item.nickname || item.name || `Trader_${traderId.slice(0, 8)}`,
    avatar: item.headPic || item.avatar || item.headUrl || null,
    roi,
    pnl,
    winRate: 0,
    maxDrawdown: 0,
    followers,
  }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Weex Copy Trading 数据抓取 (API via Puppeteer)`)
  console.log(`${'='.repeat(50)}`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标周期: ${periods.join(', ')}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=http://127.0.0.1:7890',
    ],
  })

  const traders = new Map()

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    // Navigate to establish session/cookies
    console.log('\n📋 加载页面...')
    await page.goto('https://www.weex.com/zh-CN/copy-trading', {
      waitUntil: 'networkidle0',
      timeout: 60000,
    }).catch(() => console.log('  ⚠ 页面加载超时，继续...'))
    await sleep(5000)

    const title = await page.title()
    console.log(`  页面标题: ${title}`)
    if (title.includes('moment') || title.includes('Check')) {
      console.log('  ⚠ CF 挑战，等待...')
      await sleep(15000)
    }

    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button, [role="button"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (['ok', 'got it', 'accept', 'close', 'confirm', '知道了', '确定'].some(t => text.includes(t))) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(1000)

    // 1. Fetch topTraderListView
    console.log('\n📊 调用 topTraderListView API...')
    const topResult = await page.evaluate(async () => {
      try {
        const resp = await fetch('/api/v1/public/trace/topTraderListView', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        return await resp.json()
      } catch (e) { return { error: e.message } }
    })

    if (topResult?.data && Array.isArray(topResult.data)) {
      for (const section of topResult.data) {
        const list = section.list || []
        let added = 0
        for (const item of list) {
          const t = parseTrader(item)
          if (t && !traders.has(t.traderId)) { traders.set(t.traderId, t); added++ }
        }
        if (list.length) console.log(`  ${section.tab || section.desc || '?'}: ${list.length} 条, 新增 ${added}`)
      }
      console.log(`  累计: ${traders.size} 个`)
    } else {
      console.log(`  ⚠ topTraderListView 失败:`, topResult?.error || topResult?.msg || 'unknown')
    }

    // 2. Get sort conditions
    console.log('\n📊 获取排序条件...')
    const sortResult = await page.evaluate(async () => {
      try {
        const resp = await fetch('/api/v1/public/trace/sortConditionList', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        return await resp.json()
      } catch (e) { return { error: e.message } }
    })

    let sortRules = []
    if (sortResult?.data && Array.isArray(sortResult.data)) {
      sortRules = sortResult.data.map(s => s.sortRule || s.value || s.key).filter(Boolean)
      console.log(`  排序规则: ${sortRules.join(', ')}`)
    } else {
      // Fallback common sort rules
      sortRules = ['total_roi', 'three_weeks_roi', 'follower_count', 'three_weeks_pnl', 'win_rate']
      console.log(`  使用默认排序规则: ${sortRules.join(', ')}`)
    }

    // 3. Fetch traderListView with each sort rule
    console.log('\n📊 调用 traderListView API (分页)...')
    for (const sortRule of sortRules) {
      let pageNo = 1
      let emptyCount = 0

      while (pageNo <= 20 && emptyCount < 2) {
        const result = await page.evaluate(async (params) => {
          try {
            const resp = await fetch('/api/v1/public/trace/traderListView', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(params),
            })
            return await resp.json()
          } catch (e) { return { error: e.message } }
        }, { sortRule, pageNo, pageSize: 50, simulation: 0 })

        let list = []
        if (result?.data) {
          if (Array.isArray(result.data)) list = result.data
          else if (result.data.list) list = result.data.list
          else if (result.data.records) list = result.data.records
        }

        if (list.length === 0) { emptyCount++; break }

        let added = 0
        for (const item of list) {
          const t = parseTrader(item)
          if (t && !traders.has(t.traderId)) { traders.set(t.traderId, t); added++ }
        }

        process.stdout.write(`\r  ${sortRule} p${pageNo}: +${added} → ${traders.size}`)
        if (added === 0) emptyCount++
        else emptyCount = 0

        if (list.length < 50) break
        pageNo++
        await new Promise(r => setTimeout(r, 300))
      }
      console.log()
    }

    console.log(`\n📊 总计: ${traders.size} 个唯一交易员`)

    // Save for all periods
    const allTraders = Array.from(traders.values())
    allTraders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

    const results = []
    for (const period of periods) {
      console.log(`\n💾 保存 ${allTraders.length} 条 ${period} 数据...`)
      const capturedAt = new Date().toISOString()

      // Upsert sources
      const sourcesData = allTraders.map(t => ({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: t.traderId,
        handle: t.nickname,
        avatar_url: t.avatar || null,
        is_active: true,
      }))
      await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })

      // Upsert snapshots
      const snapshotsData = allTraders.map((t, idx) => {
        const arenaScore = calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore
        if (idx < 5) console.log(`  ${idx + 1}. ${t.nickname.slice(0, 15)}: ROI ${t.roi.toFixed(2)}% → Score ${arenaScore}`)
        return {
          source: SOURCE,
          source_trader_id: t.traderId,
          season_id: period,
          rank: idx + 1,
          roi: t.roi,
          pnl: t.pnl || null,
          win_rate: t.winRate || null,
          max_drawdown: t.maxDrawdown || null,
          followers: t.followers || null,
          arena_score: arenaScore,
          captured_at: capturedAt,
        }
      })

      const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
        onConflict: 'source,source_trader_id,season_id'
      })

      if (error) {
        console.log(`  ⚠ 批量保存失败: ${error.message}`)
        let saved = 0
        for (const s of snapshotsData) {
          const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
          if (!e) saved++
        }
        results.push({ period, saved })
      } else {
        console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
        results.push({ period, saved: snapshotsData.length })
      }
    }

    await page.close()

    console.log(`\n${'='.repeat(50)}`)
    console.log(`✅ Weex 完成！`)
    for (const r of results) console.log(`  ${r.period}: ${r.saved} 条`)
    console.log(`${'='.repeat(50)}`)

  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
