/**
 * BitMart 合约跟单排行榜数据抓取
 *
 * URL: https://www.bitmart.com/en-US/futures/copy-trading
 *
 * BitMart 有 Cloudflare 保护，需要使用 Playwright 抓取页面数据
 * 通过拦截内部 API 调用获取交易员数据
 *
 * 用法: node scripts/import/import_bitmart.mjs [7D|30D|90D|ALL]
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing env'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'bitmart'
const BASE_URL = 'https://www.bitmart.com/en-US/futures/copy-trading'
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
  console.log(`\n📋 抓取 BitMart ${period} 排行榜...`)

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
  })

  const traders = new Map()

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('trader') && !url.includes('leader') && !url.includes('rank') && !url.includes('gw/mix')) return

    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const text = await response.text().catch(() => '')
      if (!text) return
      const json = JSON.parse(text)

      let list = []
      if (json?.data?.list && Array.isArray(json.data.list)) list = json.data.list
      else if (json?.data?.traders && Array.isArray(json.data.traders)) list = json.data.traders
      else if (json?.data?.records && Array.isArray(json.data.records)) list = json.data.records
      else if (Array.isArray(json?.data)) list = json.data
      else if (json?.result?.list && Array.isArray(json.result.list)) list = json.result.list

      if (list.length > 0) {
        const endpoint = url.split('?')[0].split('/').slice(-3).join('/')
        console.log(`  📡 API 拦截 (${endpoint}): ${list.length} 条`)
        if (list[0]) console.log(`    样本字段: ${Object.keys(list[0]).slice(0, 15).join(', ')}`)

        for (const t of list) {
          const traderId = String(t.uid || t.trader_id || t.traderId || t.userId || t.id || '')
          if (!traderId || traderId === 'undefined' || traders.has(traderId)) continue

          let roi = parseFloat(String(t.roi || t.profit_rate || t.profitRate || t.returnRate || 0))
          if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

          traders.set(traderId, {
            traderId,
            nickname: t.nickname || t.trader_name || t.traderName || t.nickName || t.name || `Trader_${traderId.slice(0, 8)}`,
            avatarUrl: t.avatar || t.head_url || t.headUrl || t.avatarUrl || null,
            roi,
            pnl: parseFloat(String(t.pnl || t.total_pnl || t.totalPnl || t.profit || 0)),
            winRate: t.win_rate != null ? parseFloat(String(t.win_rate)) : (t.winRate != null ? parseFloat(String(t.winRate)) : null),
            maxDrawdown: t.max_drawdown != null ? parseFloat(String(t.max_drawdown)) : (t.maxDrawdown != null ? parseFloat(String(t.maxDrawdown)) : null),
            followers: parseInt(String(t.followers || t.follower_count || t.followerCount || t.copyCount || 0)),
          })
        }
        console.log(`    累计: ${traders.size} 个`)
      }
    } catch (e) { /* ignore non-JSON */ }
  })

  try {
    console.log(`  导航到 ${BASE_URL}...`)
    await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {
      console.log('  ⚠ 页面加载超时，继续...')
    })
    await sleep(8000)

    const title = await page.title()
    console.log(`  页面标题: ${title}`)
    if (title.includes('Just a moment') || title.includes('Cloudflare')) {
      console.log('  ⚠ Cloudflare 挑战，等待...')
      await sleep(15000)
    }

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, [role="button"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (['ok', 'got it', 'accept', 'close', 'confirm', 'i understand', 'i agree'].some(t => text.includes(t))) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)

    // 切换周期
    console.log(`  切换到 ${period} 周期...`)
    const periodTexts = { '7D': ['7 Days', '7D', '7 Day'], '30D': ['30 Days', '30D', '30 Day'], '90D': ['90 Days', '90D', '90 Day'] }
    const clicked = await page.evaluate((targets) => {
      for (const txt of targets) {
        const els = [...document.querySelectorAll('button, [role="tab"], span, div, a')]
        for (const el of els) {
          if ((el.textContent || '').trim() === txt && el.offsetWidth > 0) {
            try { el.click(); return txt } catch {}
          }
        }
      }
      return null
    }, periodTexts[period] || [])
    if (clicked) {
      console.log(`  ✓ 点击了 "${clicked}"`)
      await sleep(3000)
    }

    console.log(`  API 拦截到: ${traders.size} 个`)

    // DOM 提取
    if (traders.size < 10) {
      console.log(`  从 DOM 提取数据...`)
      const pageData = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="list-row"], [class*="leader"]').forEach(card => {
          const text = card.innerText || ''
          if (!text.includes('%') || text.length > 2000 || text.length < 30) return
          const roiMatch = text.match(/([+-]?\d{1,5}(?:\.\d{1,2})?)\s*%/)
          if (!roiMatch) return
          const roi = parseFloat(roiMatch[1])
          if (roi === 0 || isNaN(roi)) return
          const lines = text.split('\n').filter(l => {
            const t = l.trim()
            return t && t.length > 1 && t.length < 30 && !t.includes('%') && !t.match(/^\d/) && !t.includes('Copy') && !t.includes('Follow')
          })
          const nickname = lines[0]?.trim() || ''
          if (!nickname) return
          const traderId = 'bitmart_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
          if (!traderId || traderId === 'bitmart_' || seen.has(traderId)) return
          seen.add(traderId)
          let winRate = null
          const wrMatch = text.match(/(?:Win|胜率|Win Rate)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
          if (wrMatch) winRate = parseFloat(wrMatch[1])
          let maxDrawdown = null
          const mddMatch = text.match(/(?:MDD|DD|回撤|Drawdown|Max DD)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
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
      await page.evaluate(() => {
        document.querySelectorAll('button').forEach(btn => {
          const text = (btn.textContent || '').toLowerCase()
          if (text.includes('load more') || text.includes('more') || text.includes('更多')) {
            try { btn.click() } catch {}
          }
        })
      }).catch(() => {})
      console.log(`    滚动 ${i + 1}: ${traders.size} 个`)
    }

    await page.screenshot({ path: `/tmp/bitmart_${period}_${Date.now()}.png`, fullPage: true }).catch(() => {})
  } finally {
    await page.close()
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
      profile_url: `https://www.bitmart.com/en-US/futures/copy-trading/trader/${t.traderId}`,
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
  console.log(`BitMart Copy Trading 数据抓取 (Playwright)`)
  console.log(`${'='.repeat(50)}`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`URL: ${BASE_URL}`)
  console.log(`目标周期: ${periods.join(', ')}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const results = []
  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 ${period} 排行榜`)
      console.log(`${'='.repeat(50)}`)

      const traders = await fetchLeaderboard(browser, period)
      if (traders.length === 0) {
        console.log(`  ⚠ ${period} 无数据 (BitMart 有 Cloudflare 保护，可能需要代理)`)
        results.push({ period, count: 0, saved: 0 })
        continue
      }

      const saved = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved, topRoi: traders[0]?.roi || 0 })
      console.log(`  ✅ ${period} 完成: ${saved} 条`)

      if (periods.indexOf(period) < periods.length - 1) await sleep(3000)
    }

    console.log(`\n${'='.repeat(50)}`)
    console.log(`✅ BitMart 完成`)
    for (const r of results) {
      console.log(`   ${r.period}: ${r.saved}/${r.count} 条${r.topRoi ? `, TOP ROI ${r.topRoi.toFixed(2)}%` : ''}`)
    }
    console.log(`${'='.repeat(50)}`)
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
