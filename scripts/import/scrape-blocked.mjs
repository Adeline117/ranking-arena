/**
 * 用 Playwright 轻量级抓取被封平台
 * 一次只开一个浏览器，抓完关掉再开下一个
 * 通过拦截 API 响应获取数据
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// Load env
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
function calcScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  let rs = Math.min(70, roi > 0 ? Math.log(1 + roi/100) * 25 : Math.max(-70, roi/100 * 50))
  let ds = dd != null ? Math.max(0, 15 * (1 - dd/100)) : 7.5
  let ss = wr != null ? Math.min(15, wr/100 * 15) : 7.5
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
    trades_count: t.trades, follower_count: t.followers,
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

// ============================================
// Generic: open page, intercept API, scroll to load more
// ============================================
async function scrapeWithIntercept(config) {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'] })
  
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    })
    const page = await ctx.newPage()
    
    const collected = []
    
    // Intercept API responses
    page.on('response', async res => {
      const url = res.url()
      if (config.matchUrl(url)) {
        try {
          const data = await res.json()
          const items = config.extract(data)
          if (items?.length) {
            collected.push(...items)
            process.stdout.write(`\r  拦截: ${collected.length} 条`)
          }
        } catch {}
      }
    })
    
    console.log(`  打开 ${config.url}...`)
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await sleep(3000)
    
    // Close popups
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', 'button:has-text("OK")', '[class*="close"]']) {
      try { await page.click(sel, { timeout: 1000 }) } catch {}
    }
    
    // If config has a tab to click (e.g. "30D" period tab)
    if (config.clickTab) {
      for (const tab of config.clickTab) {
        try { await page.click(tab, { timeout: 3000 }); await sleep(2000) } catch {}
      }
    }
    
    // Scroll to load more
    for (let i = 0; i < (config.scrolls || 15); i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
      
      // Click "load more" button if exists
      if (config.loadMore) {
        try { await page.click(config.loadMore, { timeout: 1000 }) } catch {}
      }
      
      // Try pagination
      if (config.nextPage) {
        try { await page.click(config.nextPage, { timeout: 1000 }); await sleep(2000) } catch {}
      }
    }
    
    console.log(`\n  总计拦截: ${collected.length}`)
    await ctx.close()
    return collected
  } finally {
    await browser.close()
  }
}

// ============================================
// Platform configs
// ============================================

async function scrapeBinanceFutures() {
  console.log('\n📊 Binance Futures...')
  const traders = await scrapeWithIntercept({
    url: 'https://www.binance.com/en/copy-trading',
    scrolls: 20,
    matchUrl: url => url.includes('copy-trade') && url.includes('query-list'),
    extract: data => {
      const list = data?.data?.list
      if (!Array.isArray(list)) return null
      return list.map(it => ({
        id: it.leadPortfolioId || it.portfolioId,
        name: it.nickname, avatar: it.userPhotoUrl,
        profileUrl: `https://www.binance.com/en/copy-trading/lead-details/${it.leadPortfolioId}`,
        roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
        pnl: it.pnl != null ? parseFloat(it.pnl) : null,
        wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
        dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
        trades: it.tradeCount, followers: it.copierNum,
      }))
    },
  })
  // Deduplicate
  const unique = [...new Map(traders.map(t => [t.id, t])).values()]
  if (unique.length) {
    const saved = await save('binance_futures', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  } else console.log('  ❌ 0 条')
}

async function scrapeBitgetFutures() {
  console.log('\n📊 Bitget Futures...')
  const traders = await scrapeWithIntercept({
    url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
    scrolls: 20,
    matchUrl: url => url.includes('queryCopyTraderList') || (url.includes('trader') && url.includes('list')),
    extract: data => {
      const list = data?.data?.list || data?.data?.traders || (Array.isArray(data?.data) ? data.data : null)
      if (!Array.isArray(list)) return null
      return list.map(it => ({
        id: it.traderId, name: it.nickName || it.nickname,
        avatar: it.headUrl || it.avatar,
        profileUrl: `https://www.bitget.com/copy-trading/trader/${it.traderId}/futures`,
        roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
        pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
        wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
        dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
        trades: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
        followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
      }))
    },
  })
  const unique = [...new Map(traders.map(t => [t.id, t])).values()]
  if (unique.length) {
    const saved = await save('bitget_futures', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  } else console.log('  ❌ 0 条')
}

async function scrapeMEXC() {
  console.log('\n📊 MEXC...')
  const traders = await scrapeWithIntercept({
    url: 'https://www.mexc.com/futures/copyTrade/home',
    scrolls: 15,
    matchUrl: url => url.includes('copy') && (url.includes('trader') || url.includes('rank') || url.includes('leader')),
    extract: data => {
      let list = data?.data?.list || data?.data?.items || data?.data?.traders || data?.list
      if (!Array.isArray(list)) return null
      return list.map(it => ({
        id: it.traderUid || it.uid || it.traderId || String(it.id || ''),
        name: it.nickName || it.nickname || it.name,
        avatar: it.avatarUrl || it.avatar,
        roi: it.roi != null ? parseFloat(it.roi) : (it.roiRate != null ? parseFloat(it.roiRate) * 100 : null),
        pnl: it.profit != null ? parseFloat(it.profit) : (it.pnl != null ? parseFloat(it.pnl) : null),
        wr: it.winRate != null ? parseFloat(it.winRate) * 100 : (it.winRatio != null ? parseFloat(it.winRatio) * 100 : null),
        dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
        followers: it.copyCount || it.followerCount,
      }))
    },
  })
  const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
  if (unique.length) {
    const saved = await save('mexc', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  } else console.log('  ❌ 0 条')
}

async function scrapeKuCoin() {
  console.log('\n📊 KuCoin...')
  const traders = await scrapeWithIntercept({
    url: 'https://www.kucoin.com/copy-trading/leaderboard',
    scrolls: 20,
    matchUrl: url => url.includes('leaderboard') || url.includes('leader-list'),
    extract: data => {
      const list = data?.data?.items || data?.data?.list || data?.result?.list
      if (!Array.isArray(list)) return null
      return list.map(it => ({
        id: it.leaderId || it.uid || it.traderId,
        name: it.nickName || it.nickname,
        avatar: it.avatar,
        profileUrl: it.leaderId ? `https://www.kucoin.com/copy-trading/leader/${it.leaderId}` : null,
        roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
        pnl: it.pnl != null ? parseFloat(it.pnl) : null,
        wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
        dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
        followers: it.followerCount,
      }))
    },
  })
  const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
  if (unique.length) {
    const saved = await save('kucoin', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  } else console.log('  ❌ 0 条')
}

async function scrapeCoinEx() {
  console.log('\n📊 CoinEx...')
  const traders = await scrapeWithIntercept({
    url: 'https://www.coinex.com/en/copy-trading/futures',
    scrolls: 15,
    matchUrl: url => url.includes('copytrading') || url.includes('copy-trading'),
    extract: data => {
      const list = data?.data?.list || data?.data?.traders || data?.data
      if (!Array.isArray(list)) return null
      return list.map(it => ({
        id: it.trader_id || it.uid || String(it.id || ''),
        name: it.nickname || it.name,
        avatar: it.avatar,
        roi: it.roi != null ? parseFloat(it.roi) : null,
        pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
        wr: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
      }))
    },
  })
  const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
  if (unique.length) {
    const saved = await save('coinex', unique, 'current_30d')
    console.log(`  ✅ ${saved} 条保存`)
  } else console.log('  ❌ 0 条')
}

// ============================================
// Main
// ============================================
async function main() {
  const target = process.argv[2] || 'all'
  console.log(`🚀 Playwright 浏览器抓取 [${target}]`)
  
  const platforms = {
    binance: scrapeBinanceFutures,
    bitget: scrapeBitgetFutures,
    mexc: scrapeMEXC,
    kucoin: scrapeKuCoin,
    coinex: scrapeCoinEx,
  }
  
  if (target === 'all') {
    for (const [name, fn] of Object.entries(platforms)) {
      try { await fn() } catch (e) { console.log(`  ❌ ${name} 失败: ${e.message}`) }
    }
  } else if (platforms[target]) {
    await platforms[target]()
  } else {
    console.log(`可选: ${Object.keys(platforms).join(', ')}, all`)
  }
  
  console.log('\n✅ 全部完成!')
}

main().catch(console.error)
