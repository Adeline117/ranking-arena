/**
 * XT.com Copy Trading 排行榜数据抓取
 *
 * URL: https://www.xt.com/en/copy-trading/futures
 *
 * XT.com 需要使用 Playwright 抓取页面数据并拦截内部 API
 *
 * 用法: node scripts/import/import_xt.mjs [7D|30D|90D|ALL]
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing env'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'xt'
const BASE_URL = 'https://www.xt.com/en/copy-trading/futures'
const TARGET_COUNT = 500

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

const ARENA_CONFIG = {
  MAX_RETURN_SCORE: 70,
  MAX_PNL_SCORE: 15,
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  PNL_PARAMS: {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  },
}

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, ARENA_CONFIG.MAX_RETURN_SCORE) : 0
  // PnL score (0-15)
  const pnlParams = ARENA_CONFIG.PNL_PARAMS[period] || ARENA_CONFIG.PNL_PARAMS['90D']
  let pnlScore = 0
  if (pnl !== null && pnl !== undefined && pnl > 0) {
    const logArg = 1 + pnl / pnlParams.base
    if (logArg > 0) {
      pnlScore = clip(ARENA_CONFIG.MAX_PNL_SCORE * Math.tanh(pnlParams.coeff * Math.log(logArg)), 0, ARENA_CONFIG.MAX_PNL_SCORE)
    }
  }
  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['30D']
}

async function fetchLeaderboard(browser, period) {
  console.log(`\n📋 抓取 XT.com ${period} 排行榜...`)

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })

  const page = await context.newPage()
  const traders = new Map()

  // 拦截 API 响应 - XT uses elite-leader-list-v2
  page.on('response', async (response) => {
    const url = response.url()
    // Only match copy-trade leader endpoints, skip symbol lists
    if (url.includes('symbol')) return
    if (!url.includes('leader') && !url.includes('elite') && !url.includes('trader-list')) return

    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      let list = []

      // XT.com elite-leader-list-v2: result is array of { sotType, hasMore, items: [...traders] }
      if (Array.isArray(json?.result)) {
        for (const category of json.result) {
          if (category.items && Array.isArray(category.items) && category.items.length > 0) {
            console.log(`  📡 API 拦截 (${category.sotType || 'unknown'}): ${category.items.length} 条`)
            if (category.items[0]) {
              console.log(`    样本字段: ${Object.keys(category.items[0]).slice(0, 12).join(', ')}`)
            }
            list.push(...category.items)
          }
        }
      }
      // Fallback patterns
      else if (json?.result?.items && Array.isArray(json.result.items)) list = json.result.items
      else if (json?.data?.list && Array.isArray(json.data.list)) list = json.data.list

      if (list.length > 0) {
        for (const t of list) {
          const traderId = String(t.accountId || t.uid || t.userId || t.traderId || t.id || '')
          if (!traderId || traderId === 'undefined' || traders.has(traderId)) continue

          // XT incomeRate is decimal: 1.0099 = 100.99%
          let roi = parseFloat(String(t.incomeRate || t.roi || t.returnRate || 0))
          if (Math.abs(roi) > 0 && Math.abs(roi) < 50) roi *= 100

          // XT winRate is decimal: "1" = 100%, "0.6" = 60%
          let winRate = t.winRate !== undefined ? parseFloat(String(t.winRate)) : null
          if (winRate !== null && winRate <= 1) winRate *= 100

          // XT maxRetraction is decimal: 0.5355 = 53.55%
          let maxDrawdown = t.maxRetraction !== undefined ? parseFloat(String(t.maxRetraction)) : null
          if (maxDrawdown !== null && maxDrawdown <= 1) maxDrawdown *= 100

          traders.set(traderId, {
            traderId,
            nickname: t.nickName || t.nickname || t.name || `Trader_${traderId.slice(0, 8)}`,
            avatarUrl: t.avatar || null,
            roi,
            pnl: parseFloat(String(t.income || t.pnl || t.profit || 0)),
            winRate,
            maxDrawdown,
            followers: parseInt(String(t.followerCount || t.followNumber || 0)),
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
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'I understand', 'Confirm', 'I am not', 'Start']) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.count() > 0) {
        await btn.first().click().catch(() => {})
        await sleep(500)
      }
    }
    await sleep(2000)

    // 切换到 Futures 标签（如果有）
    for (const tab of ['Futures', 'USDT-M', 'Contract']) {
      const el = page.getByText(tab, { exact: true })
      if (await el.count() > 0) {
        await el.first().click().catch(() => {})
        console.log(`  ✓ 点击了 "${tab}" 标签`)
        await sleep(2000)
        break
      }
    }

    // 切换周期
    console.log(`  切换到 ${period} 周期...`)
    const periodTexts = {
      '7D': ['7 Days', '7D', '7 Day', 'Weekly'],
      '30D': ['30 Days', '30D', '30 Day', 'Monthly'],
      '90D': ['90 Days', '90D', '90 Day', 'Quarterly'],
    }
    for (const txt of periodTexts[period] || []) {
      const el = page.getByText(txt, { exact: true })
      if (await el.count() > 0) {
        await el.first().click().catch(() => {})
        console.log(`  ✓ 点击了 "${txt}"`)
        await sleep(3000)
        break
      }
    }

    console.log(`  API 拦截到: ${traders.size} 个`)

    // DOM 提取
    if (traders.size < 10) {
      console.log(`  从 DOM 提取数据...`)
      const pageData = await page.evaluate(() => {
        const results = []
        const seen = new Set()

        // XT.com 使用卡片式布局
        document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="expert"]').forEach(card => {
          const text = card.innerText || ''
          if (!text.includes('%') || text.length > 2000 || text.length < 30) return

          const roiMatch = text.match(/([+-]?\d{1,5}(?:\.\d{1,2})?)\s*%/)
          if (!roiMatch) return
          const roi = parseFloat(roiMatch[1])
          if (roi === 0 || isNaN(roi)) return

          const lines = text.split('\n').filter(l => {
            const t = l.trim()
            return t && t.length > 1 && t.length < 30 &&
                   !t.includes('%') && !t.match(/^\d/) &&
                   !t.includes('Copy') && !t.includes('Follow') &&
                   !t.includes('ROI') && !t.includes('PnL')
          })
          const nickname = lines[0]?.trim() || ''
          if (!nickname) return

          const traderId = 'xt_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
          if (!traderId || traderId === 'xt_' || seen.has(traderId)) return
          seen.add(traderId)

          let winRate = null
          const wrMatch = text.match(/Win\s*Rate[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
          if (wrMatch) winRate = parseFloat(wrMatch[1])

          let maxDrawdown = null
          const mddMatch = text.match(/(?:MDD|Drawdown|Max\s*DD)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
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

    // 滚动加载
    for (let i = 0; i < 10 && traders.size < TARGET_COUNT; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      const moreBtn = page.getByText(/load more|more|加载更多|查看更多/i)
      if (await moreBtn.count() > 0) await moreBtn.first().click().catch(() => {})
      console.log(`    滚动 ${i + 1}: ${traders.size} 个`)
    }

    await page.screenshot({ path: `/tmp/xt_${period}_${Date.now()}.png`, fullPage: true }).catch(() => {})
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
      is_active: true
    })),
    { onConflict: 'source,source_trader_id' }
  )

  const snapshotsData = topTraders.map((t, idx) => {
    const normalizedWr = t.winRate != null ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate) : null
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
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, normalizedWr, period),
      captured_at: capturedAt
    }
  })

  snapshotsData.slice(0, 5).forEach((s, i) => {
    console.log(`    ${i + 1}. ${topTraders[i].nickname?.slice(0, 15)}: ROI ${s.roi?.toFixed(2)}% → Score ${s.arena_score}`)
  })

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
    onConflict: 'source,source_trader_id,season_id'
  })

  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, {
        onConflict: 'source,source_trader_id,season_id'
      })
      if (!e) saved++
    }
    return saved
  }

  console.log(`  ✓ 保存成功: ${topTraders.length} 条`)
  return topTraders.length
}

async function main() {
  const periods = getTargetPeriods()
  console.log(`\n${'='.repeat(50)}`)
  console.log(`XT.com Copy Trading 数据抓取 (Playwright)`)
  console.log(`${'='.repeat(50)}`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`URL: ${BASE_URL}`)
  console.log(`目标周期: ${periods.join(', ')}`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const results = []
  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 ${period} 排行榜`)
      console.log(`${'='.repeat(50)}`)

      const traders = await fetchLeaderboard(browser, period)
      if (traders.length === 0) {
        console.log(`  ⚠ ${period} 无数据`)
        results.push({ period, count: 0, saved: 0 })
        continue
      }

      const saved = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved, topRoi: traders[0]?.roi || 0 })
      console.log(`  ✅ ${period} 完成: ${saved} 条`)

      if (periods.indexOf(period) < periods.length - 1) await sleep(3000)
    }

    console.log(`\n${'='.repeat(50)}`)
    console.log(`✅ XT.com 完成`)
    for (const r of results) {
      console.log(`   ${r.period}: ${r.saved}/${r.count} 条${r.topRoi ? `, TOP ROI ${r.topRoi.toFixed(2)}%` : ''}`)
    }
    console.log(`${'='.repeat(50)}`)
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
