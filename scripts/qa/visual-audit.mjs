/**
 * Arena 逐页截图视觉审计采集器
 *
 * 为全站路由截 桌面(1280×800) + 移动(375×812) 两张全页图，
 * 输出 /tmp/arena-shots/<slug>.{desktop,mobile}.png + /tmp/arena-visual-index.json。
 * 截图本身不评分 —— 由人/Claude 逐张审阅，按 arena-design-audit 10 类 80 项打分。
 *
 * 用法:
 *   BASE_URL=http://localhost:3000 node scripts/qa/visual-audit.mjs        # 本地
 *   BASE_URL=https://www.arenafi.org node scripts/qa/visual-audit.mjs      # 线上（只读）
 *   node scripts/qa/visual-audit.mjs --core   # 只截核心路径（快速）
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const CORE_ONLY = process.argv.includes('--core')
const OUT_DIR = '/tmp/arena-shots'
const PAGE_DELAY_MS = BASE.includes('localhost') ? 300 : 1000

// 核心路径（数据可视化页额外截周期切换）
const CORE_ROUTES = [
  '/',
  '/rankings',
  '/rankings/tokens',
  '/rankings/exchanges',
  '/rankings/weekly',
  '/trader/soul',
  '/hot',
  '/feed',
  '/search?q=btc',
  '/compare',
  '/pricing',
]

// 次要路径（单张审阅即可）
const SECONDARY_ROUTES = [
  '/market',
  '/market/funding-rates',
  '/market/open-interest',
  '/groups',
  '/flash-news',
  '/quiz',
  '/learn',
  '/learn/how-arena-score-works',
  '/methodology',
  '/help',
  '/api-docs',
  '/status',
  '/about',
  '/privacy',
  '/terms',
  '/login',
  '/onboarding',
  '/referral',
  '/exchange/binance',
  '/rankings/tokens/BTC',
  '/s/BTC',
  '/hashtag/btc',
  '/u/arena_bot',
  // 登录态页（未登录截到登录墙/空态本身也是 UX 检查点）
  '/settings',
  '/watchlist',
  '/notifications',
  '/portfolio',
]

const slugify = (route) => route.replace(/[/?=&]/g, '_').replace(/^_/, '') || 'home'

async function shoot(ctx, route, viewport, tag) {
  const page = await ctx.newPage()
  const rec = { route, tag, file: null, loadMs: 0, status: null, error: null }
  const t0 = Date.now()
  try {
    const resp = await page.goto(`${BASE}${route}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    rec.status = resp?.status()
    await page.waitForTimeout(BASE.includes('localhost') ? 3500 : 5000)
    rec.loadMs = Date.now() - t0
    const file = `${OUT_DIR}/${slugify(route)}.${tag}.png`
    await page.screenshot({ path: file, fullPage: true })
    rec.file = file
  } catch (e) {
    rec.error = String(e.message).slice(0, 200)
  }
  await page.close()
  return rec
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const routes = CORE_ONLY ? CORE_ROUTES : [...CORE_ROUTES, ...SECONDARY_ROUTES]

  // 动态样本 ID（与 button-sweep 同源）
  if (!CORE_ONLY) {
    const jget = (p) =>
      fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(15000) })
        .then((r) => r.json())
        .catch(() => null)
    const post = (await jget('/api/posts?limit=1'))?.data?.posts?.[0]?.id
    if (post) routes.push(`/post/${post}`)
    const group = (await jget('/api/groups?limit=1'))?.data?.groups?.[0]?.id
    if (group) routes.push(`/groups/${group}`)
  }

  const browser = await chromium.launch({ headless: true })
  const index = []
  console.log(`== 视觉审计: ${routes.length} 路由 × 2 视口 @ ${BASE} ==`)

  for (const route of routes) {
    const desktopCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaQA',
    })
    const mobileCtx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1 ArenaQA',
    })
    const d = await shoot(desktopCtx, route, { width: 1280, height: 800 }, 'desktop')
    const m = await shoot(mobileCtx, route, { width: 375, height: 812 }, 'mobile')
    index.push(d, m)
    const flag = d.error || m.error ? ' ⚠️' : ''
    console.log(`  ${route} ${d.status || 'ERR'} d:${d.loadMs}ms m:${m.loadMs}ms${flag}`)
    await desktopCtx.close()
    await mobileCtx.close()
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS))
  }

  await browser.close()
  fs.writeFileSync('/tmp/arena-visual-index.json', JSON.stringify(index, null, 2))
  const ok = index.filter((r) => r.file).length
  console.log(`\n== 截图 ${ok}/${index.length} 成功 → ${OUT_DIR} ==`)
  console.log('索引: /tmp/arena-visual-index.json')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
