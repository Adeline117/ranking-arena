/**
 * Playwright + ClashX Pro 代理 - 浏览器过 CF challenge 后拦截 API
 * 一次只跑一个平台，严格控制内存
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CLASH_API = 'http://127.0.0.1:9090'
const PROXY = 'http://127.0.0.1:7890'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function calcScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  let rs = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  let ds = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  let ss = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return clip(Math.round((rs + ds + ss) * 10) / 10, 0, 100)
}

async function save(source, traders, seasonId, marketType = 'futures') {
  const now = new Date().toISOString()
  if (!traders.length) return 0
  const srcData = traders.map(t => ({
    source, source_trader_id: t.id, handle: t.name || t.id,
    avatar_url: t.avatar || null, profile_url: t.profileUrl || null,
    market_type: marketType, is_active: true,
  }))
  await supabase.from('trader_sources').upsert(srcData, { onConflict: 'source,source_trader_id' })
  const snapData = traders.map((t, i) => ({
    source, source_trader_id: t.id, season_id: seasonId, rank: i + 1,
    roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
    trades_count: t.trades, followers: t.followers,
    arena_score: calcScore(t.roi, t.pnl, t.dd, t.wr),
    captured_at: now,
  }))
  const { error } = await supabase.from('trader_snapshots').upsert(snapData, { onConflict: 'source,source_trader_id,season_id' })
  if (error) {
    let ok = 0
    for (const s of snapData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) ok++
    }
    return ok
  }
  return traders.length
}

// Clash proxy management
let originalMode = 'rule'
let originalNode = ''

async function enableProxy() {
  const config = await (await fetch(`${CLASH_API}/configs`)).json()
  originalMode = config.mode || 'rule'
  const proxies = await (await fetch(`${CLASH_API}/proxies/GLOBAL`)).json()
  originalNode = proxies.now || ''
  const sgNode = (proxies.all || []).find(n => n.includes('新加坡'))
  if (sgNode) {
    await fetch(`${CLASH_API}/proxies/GLOBAL`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sgNode }) })
  }
  await fetch(`${CLASH_API}/configs`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(1000)
  console.log(`🔄 代理: ${sgNode || 'default'} (global)`)
}

async function restoreProxy() {
  if (originalNode) {
    await fetch(`${CLASH_API}/proxies/GLOBAL`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: originalNode }) })
  }
  await fetch(`${CLASH_API}/configs`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: originalMode }) })
  console.log(`🔄 恢复: ${originalMode}`)
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    proxy: { server: PROXY },
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
  })
}

async function waitCF(page, maxWait = 20000) {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    const title = await page.title()
    if (!title.includes('moment') && !title.includes('Check') && !title.includes('Verify')) return true
    await sleep(1500)
  }
  return false
}

// ============================================
// Bitget
// ============================================
async function scrapeBitget() {
  console.log('\n📊 Bitget Futures...')
  const browser = await launchBrowser()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const traders = []

    page.on('response', async res => {
      const url = res.url()
      if (url.includes('queryCopyTrader') || url.includes('traderList') || (url.includes('trader') && url.includes('list') && url.includes('bitget'))) {
        try {
          const data = await res.json()
          const list = data?.data?.list || data?.data?.traders || (Array.isArray(data?.data) ? data.data : null)
          if (Array.isArray(list)) {
            for (const it of list) {
              if (!it.traderId) continue
              traders.push({
                id: it.traderId, name: it.nickName || it.nickname,
                avatar: it.headUrl || it.avatar,
                profileUrl: `https://www.bitget.com/copy-trading/trader/${it.traderId}/futures`,
                roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
                pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
                trades: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
                followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })

    console.log('  打开页面...')
    await page.goto('https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    const passed = await waitCF(page)
    console.log(`  CF: ${passed ? '✅ 通过' : '❌ 未通过'}`)
    
    if (passed) {
      await sleep(3000)
      // Scroll to load more + click pagination
      for (let i = 0; i < 20; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
        // Try next page button
        try {
          const nextBtn = page.locator('button.next, [class*="next"]:not([disabled]), li.next > a')
          if (await nextBtn.count()) { await nextBtn.first().click(); await sleep(2000) }
        } catch {}
      }
      
      // Also try calling API from page context
      if (traders.length < 100) {
        console.log(`\n  页内 API 补充...`)
        for (let p = 1; p <= 25; p++) {
          try {
            const data = await page.evaluate(async (pageNo) => {
              const r = await fetch('/v1/trigger/trace/queryCopyTraderList', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageNo, pageSize: 20, sort: 'ROI_DESC', range: '30d', languageType: 0 }),
              })
              return r.json()
            }, p)
            const list = data?.data?.list || data?.data
            if (!Array.isArray(list) || !list.length) break
            for (const it of list) {
              if (!it.traderId) continue
              traders.push({
                id: it.traderId, name: it.nickName,
                avatar: it.headUrl,
                roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
                pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
              })
            }
            process.stdout.write(`\r  API 页${p}: ${traders.length}`)
            await sleep(300)
          } catch { break }
        }
      }
    }

    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    if (unique.length) {
      const saved = await save('bitget_futures', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条`)
    }
    await ctx.close()
  } finally { await browser.close() }
}

// ============================================
// MEXC
// ============================================
async function scrapeMEXC() {
  console.log('\n📊 MEXC...')
  const browser = await launchBrowser()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const traders = []

    page.on('response', async res => {
      const url = res.url()
      if (url.includes('copy') && (url.includes('trader') || url.includes('rank') || url.includes('leader'))) {
        try {
          const data = await res.json()
          const list = data?.data?.list || data?.data?.items || data?.data?.traders || data?.list
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.traderUid || it.uid || it.traderId || String(it.id || '')
              if (!id) continue
              traders.push({
                id, name: it.nickName || it.nickname,
                avatar: it.avatarUrl || it.avatar,
                roi: it.roi != null ? parseFloat(it.roi) : (it.roiRate != null ? parseFloat(it.roiRate) * 100 : null),
                pnl: it.profit != null ? parseFloat(it.profit) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                followers: it.copyCount,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })

    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    const passed = await waitCF(page)
    console.log(`  CF: ${passed ? '✅' : '❌'}`)
    if (passed) {
      await sleep(3000)
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
      }
    }

    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    if (unique.length) {
      const saved = await save('mexc', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条`)
    }
    await ctx.close()
  } finally { await browser.close() }
}

// ============================================
// KuCoin
// ============================================
async function scrapeKuCoin() {
  console.log('\n📊 KuCoin...')
  const browser = await launchBrowser()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const traders = []

    page.on('response', async res => {
      const url = res.url()
      if (url.includes('leaderboard') || url.includes('leader-list') || url.includes('copy-trading')) {
        try {
          const data = await res.json()
          const list = data?.data?.items || data?.data?.list
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.leaderId || it.uid
              if (!id) continue
              traders.push({
                id, name: it.nickName || it.nickname,
                avatar: it.avatar,
                profileUrl: `https://www.kucoin.com/copy-trading/leader/${id}`,
                roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
                pnl: it.pnl != null ? parseFloat(it.pnl) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
                followers: it.followerCount,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })

    await page.goto('https://www.kucoin.com/copy-trading/leaderboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    const passed = await waitCF(page)
    console.log(`  CF: ${passed ? '✅' : '❌'}`)
    if (passed) {
      await sleep(3000)
      for (let i = 0; i < 20; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
        try { await page.click('[class*="next"]:not([disabled])', { timeout: 500 }) } catch {}
      }
    }

    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    if (unique.length) {
      const saved = await save('kucoin', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条`)
    }
    await ctx.close()
  } finally { await browser.close() }
}

// ============================================
// CoinEx
// ============================================
async function scrapeCoinEx() {
  console.log('\n📊 CoinEx...')
  const browser = await launchBrowser()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const traders = []

    page.on('response', async res => {
      const url = res.url()
      if (url.includes('copytrading') || url.includes('copy-trading') || url.includes('trader')) {
        try {
          const data = await res.json()
          const list = data?.data?.list || data?.data?.traders || (Array.isArray(data?.data) ? data.data : null)
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.trader_id || it.uid || String(it.id || '')
              if (!id) continue
              traders.push({
                id, name: it.nickname || it.name,
                avatar: it.avatar,
                roi: it.roi != null ? parseFloat(it.roi) : null,
                pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
                wr: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })

    await page.goto('https://www.coinex.com/en/copy-trading/futures', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    const passed = await waitCF(page)
    console.log(`  CF: ${passed ? '✅' : '❌'}`)
    if (passed) {
      await sleep(3000)
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
      }
    }

    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    if (unique.length) {
      const saved = await save('coinex', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条`)
    }
    await ctx.close()
  } finally { await browser.close() }
}

// ============================================
async function main() {
  const target = process.argv[2] || 'all'
  console.log(`🚀 Playwright + ClashX [${target}]`)

  await enableProxy()

  const platforms = { bitget: scrapeBitget, mexc: scrapeMEXC, kucoin: scrapeKuCoin, coinex: scrapeCoinEx }

  try {
    if (target === 'all') {
      for (const [name, fn] of Object.entries(platforms)) {
        try { await fn() } catch (e) { console.log(`  ❌ ${name}: ${e.message}`) }
      }
    } else if (platforms[target]) {
      await platforms[target]()
    }
  } finally {
    await restoreProxy()
  }
  console.log('\n✅ 完成!')
}

main().catch(async e => { console.error(e); await restoreProxy() })
