#!/usr/bin/env node
/**
 * 单平台浏览器抓取 — 极致内存优化
 * 用法: node browser-single.mjs <platform>
 * 每次只开一个 Chrome，抓完立即退出释放内存
 */
import { chromium } from 'playwright'
import { sb, sleep, cs, extractTraders, save } from './lib/index.mjs'

const PLATFORMS = {
  xt:       { url: 'https://www.xt.com/en/copy-trading/futures', source: 'xt', scroll: 15 },
  mexc:     { url: 'https://www.mexc.com/copy-trading', source: 'mexc' },
  coinex:   { url: 'https://www.coinex.com/copy-trading', source: 'coinex' },
  kucoin:   { url: 'https://www.kucoin.com/copy-trading/leaderboard', source: 'kucoin' },
  bybit:    { url: 'https://www.bybit.com/copyTrade/', source: 'bybit' },
  bingx:    { url: 'https://bingx.com/en/copy-trading/', source: 'bingx' },
  bitget_f: { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', source: 'bitget_futures' },
  bitget_s: { url: 'https://www.bitget.com/copy-trading/spot', source: 'bitget_spot' },
  phemex:   { url: 'https://phemex.com/copy-trading', source: 'phemex' },
  weex:     { url: 'https://www.weex.com/zh-CN/copy-trading', source: 'weex' },
  lbank:    { url: 'https://www.lbank.com/copy-trading', source: 'lbank' },
  blofin:   { url: 'https://blofin.com/en/copy-trade', source: 'blofin' },
}

const name = process.argv[2]
if (!PLATFORMS[name]) { console.log('❌ unknown: ' + name); process.exit(1) }
const cfg = PLATFORMS[name]

async function saveTraders(source, tradersMap, startRank) {
  const batch = [...tradersMap.values()].slice(startRank)
  if (!batch.length) return tradersMap.size
  const now = new Date().toISOString()
  for (let i = 0; i < batch.length; i += 50) {
    try {
      await sb.from('trader_sources').upsert(
        batch.slice(i, i + 50).map(t => ({ source, source_trader_id: t.id, handle: t.name || t.id, avatar_url: t.avatar, market_type: 'futures', is_active: true })),
        { onConflict: 'source,source_trader_id' }
      )
    } catch {}
  }
  for (let i = 0; i < batch.length; i += 30) {
    try {
      await sb.from('trader_snapshots').upsert(
        batch.slice(i, i + 30).map((t, j) => ({ source, source_trader_id: t.id, season_id: '30D', rank: startRank + i + j + 1, roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd, trades_count: t.trades, arena_score: cs(t.roi, t.pnl, t.dd, t.wr), captured_at: now })),
        { onConflict: 'source,source_trader_id,season_id' }
      )
    } catch {}
  }
  return tradersMap.size
}

async function main() {
  const traders = new Map()
  let savedTotal = 0

  const browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=400,300','--window-position=9999,9999',
      '--disable-gpu','--disable-extensions','--disable-dev-shm-usage',
      '--disable-background-networking','--disable-default-apps',
      '--js-flags=--max-old-space-size=256','--single-process'],
  })

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm,ico,css}', r => r.abort())
  await page.route('**/{analytics,tracking,pixel,gtag,gtm,facebook,twitter,sentry,segment,mixpanel,amplitude}*', r => r.abort())

  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const d = await res.json()
      const found = extractTraders(d)
      let newCount = 0
      for (const t of found) { if (!traders.has(t.id)) { traders.set(t.id, t); newCount++ } }
      if (newCount > 0 && traders.size - savedTotal >= 20) {
        savedTotal = await saveTraders(cfg.source, traders, savedTotal)
      }
    } catch {}
  })

  try {
    await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})

    let cfOk = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
      await sleep(1500)
    }
    if (!cfOk) { console.log('❌ CF'); await browser.close(); process.exit(1) }

    await sleep(8000)

    const scrollCount = cfg.scroll || 8
    for (let i = 0; i < scrollCount; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2500)
    }

    savedTotal = await saveTraders(cfg.source, traders, savedTotal)
    console.log(`✅ ${savedTotal}`)
  } catch (e) {
    if (savedTotal > 0) console.log(`⚠ ${savedTotal} (partial: ${e.message?.substring(0,30)})`)
    else console.log(`❌ ${e.message?.substring(0,50)}`)
  } finally {
    await browser.close().catch(()=>{})
    process.exit(0)
  }
}

main()
