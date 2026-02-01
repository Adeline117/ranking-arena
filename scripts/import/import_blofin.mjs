/**
 * BloFin Copy Trading 排行榜数据抓取
 *
 * URL: https://blofin.com/en/copy-trade
 *
 * BloFin API (openapi.blofin.com) 需要认证 (401)，使用 Playwright 抓取
 * 通过拦截页面内部 API 调用获取数据
 *
 * 用法: node scripts/import/import_blofin.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'blofin'
const BASE_URL = 'https://blofin.com/en/copy-trade'
const TARGET_COUNT = 500

// BloFin 周期映射
const PERIOD_CONFIG = {
  '7D': { blofinRange: '1', tabText: '7D', actualDays: 7 },
  '30D': { blofinRange: '2', tabText: '30D', actualDays: 30 },
  '90D': { blofinRange: '3', tabText: '90D', actualDays: 90 },
}

async function fetchLeaderboard(browser, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n📋 抓取 BloFin ${period} 排行榜...`)

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
  })

  const traders = new Map()

  // 拦截 API 响应 - BloFin uses openapi.blofin.com internally
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('trader') && !url.includes('lead') &&
        !url.includes('rank') && !url.includes('blofin')) return

    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const text = await response.text().catch(() => '')
      if (!text) return
      const json = JSON.parse(text)

      let list = []
      if (json?.data?.list && Array.isArray(json.data.list)) list = json.data.list
      else if (json?.data?.records && Array.isArray(json.data.records)) list = json.data.records
      else if (Array.isArray(json?.data)) list = json.data

      if (list.length > 0) {
        const endpoint = url.split('?')[0].split('/').slice(-3).join('/')
        console.log(`  📡 API 拦截 (${endpoint}): ${list.length} 条`)
        if (list[0]) {
          console.log(`    样本字段: ${Object.keys(list[0]).slice(0, 15).join(', ')}`)
        }

        for (const t of list) {
          const traderId = String(t.uniqueName || t.traderId || t.uid || t.id || '')
          if (!traderId || traderId === 'undefined' || traders.has(traderId)) continue

          let roi = parseFloat(String(t.roi || t.returnRate || t.pnlRatio || 0))
          if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

          traders.set(traderId, {
            traderId,
            nickname: t.nickName || t.nickname || t.name || t.uniqueName || `Trader_${traderId.slice(0, 8)}`,
            avatarUrl: t.avatar || t.avatarUrl || t.portraitLink || null,
            roi,
            pnl: parseFloat(String(t.pnl || t.profit || t.totalPnl || 0)),
            winRate: t.winRate !== undefined ? parseFloat(String(t.winRate)) : null,
            maxDrawdown: t.maxDrawdown !== undefined ? parseFloat(String(t.maxDrawdown)) : null,
            followers: parseInt(String(t.followers || t.followerCount || t.copyTraderNum || 0)),
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
    if (title.includes('Just a moment')) {
      console.log('  ⚠ Cloudflare 挑战，等待...')
      await sleep(15000)
    }

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, [role="button"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (['ok', 'got it', 'accept', 'close', 'confirm', 'i understand'].some(t => text.includes(t))) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)

    // 切换周期
    console.log(`  切换到 ${config.tabText} 周期...`)
    const clicked = await page.evaluate((tabText, days) => {
      const targets = [tabText, `${days} Days`, `${days}D`]
      for (const txt of targets) {
        const els = [...document.querySelectorAll('button, [role="tab"], span, div, a')]
        for (const el of els) {
          if ((el.textContent || '').trim() === txt && el.offsetWidth > 0) {
            try { el.click(); return txt } catch {}
          }
        }
      }
      return null
    }, config.tabText, config.actualDays)
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
        document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="lead"]').forEach(card => {
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
          const traderId = 'blofin_' + nickname.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
          if (!traderId || traderId === 'blofin_' || seen.has(traderId)) return
          seen.add(traderId)
          let winRate = null
          const wrMatch = text.match(/(?:Win|胜率)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
          if (wrMatch) winRate = parseFloat(wrMatch[1])
          let maxDrawdown = null
          const mddMatch = text.match(/(?:MDD|Drawdown|回撤)[:\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)
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

    // 翻页/滚动加载
    for (let i = 0; i < 10 && traders.size < TARGET_COUNT; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      // 分页
      await page.evaluate(() => {
        document.querySelectorAll('button, [role="button"]').forEach(btn => {
          const text = (btn.textContent || '').toLowerCase()
          if (text.includes('next') || text.includes('下一页') || text === '›') {
            try { btn.click() } catch {}
          }
        })
      }).catch(() => {})
      await sleep(2000)
      console.log(`    滚动/翻页 ${i + 1}: ${traders.size} 个`)
    }

    await page.screenshot({ path: `/tmp/blofin_${period}_${Date.now()}.png`, fullPage: true }).catch(() => {})
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
      is_active: true,
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
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, normalizedWr, period).totalScore,
      captured_at: capturedAt,
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
  const periods = getTargetPeriods(['30D'])
  console.log(`\n${'='.repeat(50)}`)
  console.log(`BloFin Copy Trading 数据抓取 (Playwright)`)
  console.log(`${'='.repeat(50)}`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`URL: ${BASE_URL}`)
  console.log(`注意: BloFin API (openapi.blofin.com) 需要认证，使用浏览器抓取`)
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
        console.log(`  ⚠ ${period} 无数据 (BloFin API 需要认证，Cloudflare 可能阻挡)`)
        results.push({ period, count: 0, saved: 0 })
        continue
      }

      const saved = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved, topRoi: traders[0]?.roi || 0 })
      console.log(`  ✅ ${period} 完成: ${saved} 条`)

      if (periods.indexOf(period) < periods.length - 1) await sleep(3000)
    }

    console.log(`\n${'='.repeat(50)}`)
    console.log(`✅ BloFin 完成`)
    for (const r of results) {
      console.log(`   ${r.period}: ${r.saved}/${r.count} 条${r.topRoi ? `, TOP ROI ${r.topRoi.toFixed(2)}%` : ''}`)
    }
    console.log(`${'='.repeat(50)}`)
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
