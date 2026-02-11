#!/usr/bin/env node
/**
 * 全平台自动刷新 — 8GB 内存优化版
 * 
 * 策略:
 * 1. API 平台: curl 抓取，零额外内存
 * 2. 浏览器平台: 单个 Chrome 实例，逐平台开 context，增量保存
 * 3. 被 kill 也无所谓 — 数据实时写入 Supabase
 * 
 * 用法: node scripts/import/refresh-all.mjs [--api-only] [--browser-only] [--platform=xxx]
 */
import { readFileSync, writeFileSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { clip, extractTraders, sb, sleep } from './lib/index.mjs'

// Load env

function arenaScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  const r = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  const d = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  const s = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return clip(Math.round((r + d + s) * 10) / 10, 0, 100)
}

async function saveBatch(source, traders) {
  if (!traders.length) return 0
  const now = new Date().toISOString()
  // Upsert sources
  for (let i = 0; i < traders.length; i += 50) {
    try { await sb.from('trader_sources').upsert(
      traders.slice(i, i + 50).map(t => ({
        source, source_trader_id: t.id, handle: t.name || t.id,
        avatar_url: t.avatar || null, market_type: t.market || 'futures', is_active: true,
      })), { onConflict: 'source,source_trader_id' }
    )} catch {}
  }
  // Upsert snapshots
  let saved = 0
  for (let i = 0; i < traders.length; i += 30) {
    const { error } = await sb.from('trader_snapshots').upsert(
      traders.slice(i, i + 30).map((t, j) => ({
        source, source_trader_id: t.id, season_id: '30D', rank: i + j + 1,
        roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
        trades_count: t.trades, arena_score: arenaScore(t.roi, t.pnl, t.dd, t.wr),
        captured_at: now,
      })), { onConflict: 'source,source_trader_id,season_id' }
    )
    if (!error) saved += Math.min(30, traders.length - i)
  }
  return saved
}

function curl(url, opts = {}) {
  const args = ['curl', '-s', '-m', String(opts.timeout || 15), '--compressed']
  if (opts.proxy) args.push('-x', opts.proxy)
  if (opts.method === 'POST') args.push('-X', 'POST')
  if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) args.push('-H', `${k}: ${v}`)
  if (opts.body) args.push('-d', opts.body)
  if (opts.output) args.push('-o', opts.output)
  args.push(url)
  try {
    // Use spawnSync to avoid shell quoting issues
    const result = spawnSync(args[0], args.slice(1), {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: (opts.timeout || 15) * 1000 + 5000
    })
    if (opts.output) return null
    return result.stdout || null
  } catch { return null }
}

const PROXY = process.env.HTTP_PROXY || null

// ============================================================
// API PLATFORMS (no browser needed)
// ============================================================

async function refreshOKX() {
  console.log('  OKX...')
  // Use original script (it works reliably)
  try {
    execSync('node scripts/import/import_okx_futures.mjs', { cwd: process.cwd(), stdio: 'pipe', timeout: 45000 })
    return '✅'
  } catch { return '❌' }
}

async function refreshHTX() {
  console.log('  HTX...')
  try {
    execSync('node scripts/import/archive/import_htx_enhanced.mjs', { cwd: process.cwd(), stdio: 'pipe', timeout: 45000 })
    return '✅'
  } catch { return '❌' }
}

async function refreshGains() {
  console.log('  Gains...')
  try {
    execSync('node scripts/import/import_gains.mjs', { cwd: process.cwd(), stdio: 'pipe', timeout: 60000 })
    return '✅'
  } catch { return '❌' }
}

async function refreshDYDX() {
  console.log('  dYdX...')
  try {
    execSync('node scripts/import/import_dydx_enhanced.mjs 30D', { cwd: process.cwd(), stdio: 'pipe', timeout: 120000 })
    return '✅'
  } catch { return '❌' }
}

async function refreshHyperliquid() {
  console.log('  Hyperliquid...')
  curl('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', { proxy: PROXY, timeout: 30, output: '/tmp/hl.json' })
  try {
    const d = JSON.parse(readFileSync('/tmp/hl.json', 'utf8'))
    const traders = d.leaderboardRows
      .filter(x => { const p = x.windowPerformances?.find(w => w[0] === 'month'); return p && p[1]?.roi })
      .map(x => { const p = x.windowPerformances.find(w => w[0] === 'month')[1]; return { id: x.ethAddress, roi: parseFloat(p.roi) * 100, pnl: parseFloat(p.pnl) } })
      .filter(x => x.roi > 0).sort((a, b) => b.roi - a.roi).slice(0, 500)
    const n = await saveBatch('hyperliquid', traders)
    return n > 0 ? `✅ ${n}` : '❌'
  } catch { return '❌' }
}

async function refreshGMX() {
  console.log('  GMX...')
  const raw = curl('https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql', {
    proxy: PROXY, method: 'POST', timeout: 20,
    headers: { 'Content-Type': 'application/json' },
    body: '{"query":"{accountStats(limit:2000,orderBy:realizedPnl_DESC){id wins losses realizedPnl maxCapital closedCount}}"}'
  })
  try {
    const d = JSON.parse(raw)
    const traders = d.data.accountStats
      .filter(s => parseFloat(s.realizedPnl) > 0 && s.closedCount > 5)
      .map(s => {
        const pnl = parseFloat(s.realizedPnl) / 1e30, cap = parseFloat(s.maxCapital) / 1e30
        return { id: s.id, pnl, roi: cap > 0 ? (pnl / cap) * 100 : 0, wr: (s.wins + s.losses) > 0 ? (s.wins / (s.wins + s.losses)) * 100 : null }
      })
      .filter(t => t.roi > 0 && t.roi < 100000).sort((a, b) => b.roi - a.roi).slice(0, 500)
    const n = await saveBatch('gmx', traders)
    return n > 0 ? `✅ ${n}` : '❌'
  } catch { return '❌' }
}

async function refreshBinance(type) {
  const isFutures = type === 'futures'
  console.log(`  Binance ${type}...`)
  const url = isFutures
    ? 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
    : 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list'
  const source = isFutures ? 'binance_futures' : 'binance_spot'
  
  try {
    const all = []
    for (let p = 1; p <= 25; p++) {
      const body = isFutures
        ? { pageNumber: p, pageSize: 20, timeRange: '30D', dataType: 'ROI', favoriteOnly: false }
        : { pageNumber: p, pageSize: 20, timeRange: '30D', dataType: 'ROI', order: 'DESC', portfolioType: 'ALL' }
      
      const raw = curl(url, {
        proxy: PROXY, method: 'POST', timeout: 15,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify(body),
      })
      
      try {
        const d = JSON.parse(raw)
        const list = d.data?.list || []
        if (!list.length) break
        for (const it of list) {
          all.push({
            id: it.leadPortfolioId || '',
            name: it.nickname || '',
            roi: isFutures
              ? (it.roi != null ? parseFloat(it.roi) * 100 : null)
              : (it.roi != null ? parseFloat(it.roi) : null),
            pnl: it.pnl != null ? parseFloat(it.pnl) : null,
            wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
            dd: isFutures
              ? (it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null)
              : (it.mdd != null ? parseFloat(it.mdd) : null),
          })
        }
      } catch { break }
    }
    
    const traders = all.filter(t => t.id).map(t => ({
      id: t.id, name: t.name, roi: t.roi, pnl: t.pnl, wr: t.wr, dd: t.dd,
      market: isFutures ? 'futures' : 'spot',
    }))
    
    const n = await saveBatch(source, traders)
    return n > 0 ? `✅ ${n}` : '❌'
  } catch (e) {
    console.log(`    Error: ${e.message?.substring(0, 80)}`)
    return '❌'
  }
}

// ============================================================
// BROWSER PLATFORMS — single Chrome, incremental save
// ============================================================

const BROWSER_PLATFORMS = [
  { name: 'xt', source: 'xt', urls: [
    'https://www.xt.com/en/copy-trading/futures',
    'https://www.xt.com/en/copy-trading/futures?sort=profit',
  ]},
  { name: 'mexc', source: 'mexc', urls: ['https://www.mexc.com/copy-trading'] },
  { name: 'coinex', source: 'coinex', urls: [
    'https://www.coinex.com/copy-trading',
    'https://www.coinex.com/copy-trading?sort=profit',
  ]},
  { name: 'kucoin', source: 'kucoin', urls: [
    'https://www.kucoin.com/copy-trading/leaderboard',
    'https://www.kucoin.com/copy-trading/leaderboard?sort=pnl',
  ]},
  { name: 'bybit', source: 'bybit', urls: ['https://www.bybit.com/copyTrade/'] },
  { name: 'bingx', source: 'bingx', urls: [
    'https://bingx.com/en/copy-trading/',
    'https://bingx.com/en/CopyTrading/leaderBoard',
  ]},
  { name: 'bitget', source: 'bitget_futures', urls: ['https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0'] },
  { name: 'phemex', source: 'phemex', urls: [
    'https://phemex.com/copy-trading',
    'https://phemex.com/copy-trading/leaderboard',
  ]},
  { name: 'weex', source: 'weex', urls: [
    'https://www.weex.com/zh-CN/copy-trading',
    'https://www.weex.com/en-US/copy-trading',
  ]},
  { name: 'lbank', source: 'lbank', urls: [
    'https://www.lbank.com/copy-trading',
    'https://www.lbank.com/en-US/copy-trading',
  ]},
  { name: 'blofin', source: 'blofin', urls: ['https://blofin.com/en/copy-trade'] },
]

async function refreshBrowserPlatforms(filter) {
  // Enable proxy
  try { await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }) } catch {}
  await sleep(500)

  const { chromium } = await import('playwright')
  const results = {}

  // Launch ONE browser for all platforms
  let browser
  try {
    browser = await chromium.launch({
      headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
      proxy: { server: PROXY },
      args: ['--window-size=400,300', '--window-position=9999,9999', '--disable-gpu', '--disable-extensions',
        '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256', '--disable-background-networking',
        '--disable-default-apps', '--disable-sync', '--no-first-run'],
    })
  } catch (e) {
    console.log('  ⚠ Chrome 启动失败:', e.message)
    return {}
  }

  const platforms = filter
    ? BROWSER_PLATFORMS.filter(p => filter.includes(p.name))
    : BROWSER_PLATFORMS

  for (const plat of platforms) {
    console.log(`  ${plat.name}...`)
    const traders = new Map()
    let savedCount = 0
    const urls = plat.urls || [plat.url]

    for (const visitUrl of urls) {
    try {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
      const page = await ctx.newPage()
      await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm,ico,css}', r => r.abort())

      // Intercept ALL JSON — save immediately
      page.on('response', async res => {
        try {
          const ct = res.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const d = await res.json()
          const found = extractTraders(d)
          let newCount = 0
          for (const t of found) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
          // Incremental save every 20 new traders
          if (newCount > 0 && traders.size - savedCount >= 20) {
            const batch = [...traders.values()].slice(savedCount)
            const n = await saveBatch(plat.source, batch)
            savedCount = traders.size
          }
        } catch {}
      })

      await page.goto(visitUrl, { timeout: 40000, waitUntil: 'load' }).catch(() => {})

      // CF wait
      let cfOk = false
      for (let i = 0; i < 25; i++) {
        const t = await page.title().catch(() => '')
        if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
        await sleep(1500)
      }

      if (cfOk) {
        await sleep(8000)
        
        // Aggressive pagination: scroll + click next buttons
        const prevCount = () => traders.size
        for (let i = 0; i < 30; i++) {
          const before = prevCount()
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
          await sleep(2000)
          
          // Try clicking pagination / "load more" / "next" buttons
          if (i % 3 === 2) {
            await page.evaluate(() => {
              // Click "next page" or pagination buttons
              const btns = [...document.querySelectorAll('button, a, [role="button"], li')]
              for (const btn of btns) {
                const text = (btn.textContent || '').trim().toLowerCase()
                const cls = (btn.className || '').toLowerCase()
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase()
                if (text === '>' || text === '›' || text === 'next' || text === '下一页' ||
                    cls.includes('next') || aria.includes('next') ||
                    (btn.tagName === 'LI' && cls.includes('next'))) {
                  try { btn.click(); return true } catch {}
                }
              }
              // Click "load more" buttons
              for (const btn of btns) {
                const text = (btn.textContent || '').trim().toLowerCase()
                if (text.includes('load more') || text.includes('more') || text.includes('查看更多') || text.includes('加载更多')) {
                  try { btn.click(); return true } catch {}
                }
              }
              return false
            }).catch(() => {})
            await sleep(3000)
          }
          
          // Stop if no new traders after 3 iterations
          if (i > 5 && prevCount() === before && i % 3 === 0) {
            const still = prevCount()
            if (still === before) break
          }
        }
      }

      // Final save
      if (traders.size > savedCount) {
        await saveBatch(plat.source, [...traders.values()])
      }

      console.log(`    URL ${visitUrl}: ${traders.size} traders so far`)

      await ctx.close()
      await sleep(1000)
    } catch (e) {
      console.log(`    URL error: ${e.message?.substring(0, 30)}`)
    }
    } // end urls loop

    // Final save all remaining
    if (traders.size > savedCount) {
      await saveBatch(plat.source, [...traders.values()])
    }

    results[plat.name] = traders.size > 0 ? `✅ ${traders.size}` : '❌ 0'
    console.log(`    ${results[plat.name]}`)
  }

  try { await browser.close() } catch {}
  try { await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }) } catch {}

  return results
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2)
  const apiOnly = args.includes('--api-only')
  const browserOnly = args.includes('--browser-only')
  const platFilter = args.find(a => a.startsWith('--platform='))?.split('=')[1]?.split(',')

  console.log(`\n🔄 全平台刷新 — ${new Date().toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles' })}`)
  console.log('=' .repeat(50))

  // Ensure proxy is global for API calls that need it
  try { await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }) } catch {}
  await sleep(500)

  const results = {}

  if (!browserOnly) {
    console.log('\n📡 API 平台:')
    results.okx = await refreshOKX()
    results.htx = await refreshHTX()
    results.gains = await refreshGains()
    results.dydx = await refreshDYDX()
    results.hyperliquid = await refreshHyperliquid()
    results.gmx = await refreshGMX()
    results.binance_futures = await refreshBinance('futures')
    results.binance_spot = await refreshBinance('spot')
  }

  if (!apiOnly) {
    console.log('\n🌐 浏览器平台:')
    const browserResults = await refreshBrowserPlatforms(platFilter)
    Object.assign(results, browserResults)
  }

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log('📊 结果:')
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k}: ${v}`)
  }

  // Restore proxy to direct
  try { await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }) } catch {}

  // Write status file
  try {
    writeFileSync('/tmp/ranking-arena-refresh.json', JSON.stringify({
      timestamp: new Date().toISOString(),
      results,
    }, null, 2))
  } catch {}
}

main().catch(e => { console.error(e); process.exit(1) })
