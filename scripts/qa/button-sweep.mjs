/**
 * Arena 全站按钮/交互运行时扫描
 *
 * 用法:
 *   node scripts/qa/button-sweep.mjs                    # 扫 production
 *   BASE_URL=http://localhost:3000 node scripts/qa/button-sweep.mjs
 *   node scripts/qa/button-sweep.mjs --lang-sweep       # 额外跑 4 语言核心路径
 *
 * 采集: pageerror（页面级崩溃）、console error、>=400 网络响应、
 *       错误边界文案、空白页。交互: 周期切换/tab/语言/主题/搜索/modal。
 * 输出: /tmp/arena-button-sweep.json + 控制台摘要
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const LANG_SWEEP = process.argv.includes('--lang-sweep')
const PAGE_DELAY_MS = 1000 // production politeness

// 动态 ID 在 main() 里从 API 取
// 覆盖页面树中的静态路由；动态路由在 main() 取真实 ID；
// 需登录态的动态路由（messages/favorites/post-edit/group-manage 等）由
// auth-button-sweep.mjs 覆盖，这里 log skip 原因（不静默跳过）。
const STATIC_ROUTES = [
  // 核心路径
  '/',
  '/rankings',
  '/rankings/tokens',
  '/rankings/exchanges',
  '/rankings/weekly',
  '/trader/soul', // 已知公开交易员（/trader/[handle]）
  '/hot',
  '/feed',
  '/search?q=btc',
  '/compare',
  // 市场
  '/market',
  '/market/funding-rates',
  '/market/open-interest',
  // 社交 / 内容
  '/groups',
  '/groups/apply',
  '/flash-news',
  '/quiz',
  '/quiz/questions',
  '/quiz/result',
  // 营收 / 转化
  '/pricing',
  '/pricing/success',
  '/referral',
  '/tip/success',
  // 账号 / 认证（未登录应跳登录墙而非崩）
  '/login',
  '/onboarding',
  '/logout',
  '/reset-password',
  '/auth/callback',
  '/claim',
  '/exchange/auth',
  '/exchange/auth/api-key',
  '/exchange/auth/callback',
  '/trader/authorize',
  // 登录态页（未登录应 redirect/空态，不崩）
  '/notifications',
  '/settings',
  '/settings/linked-accounts',
  '/watchlist',
  '/favorites',
  '/portfolio',
  '/following',
  '/channels',
  '/messages',
  '/inbox',
  '/my-posts',
  '/saved',
  '/user-center',
  // 内容 / 帮助 / 法务
  '/learn',
  '/learn/how-arena-score-works', // /learn/[slug]
  '/methodology',
  '/help',
  '/api-docs',
  '/status',
  '/offline',
  '/about',
  '/privacy',
  '/terms',
  '/disclaimer',
  '/dmca',
  // 管理后台（未登录应 403/redirect，不崩）
  '/admin',
  '/admin/monitoring',
  '/admin/monitoring/pipeline',
  '/admin/pro-metrics',
  '/admin/data-health',
  '/admin/reports',
  // 硬编码 token/tag 动态路由
  '/rankings/tokens/BTC', // /rankings/tokens/[token]
  '/s/BTC', // /s/[token]
  '/hashtag/btc', // /hashtag/[tag]
  '/exchange/binance', // /exchange/[slug]
  '/wrapped/soul', // /wrapped/[handle]
  '/u/arena_bot', // /u/[handle]
]

// 需登录态、无公开样本 ID 的动态路由 —— 由 auth-button-sweep 覆盖，此处显式记录
const SKIPPED_AUTH_ROUTES = [
  '/channels/[channelId]',
  '/messages/[conversationId]',
  '/favorites/[folderId]',
  '/post/[id]/edit',
  '/groups/[id]/new',
  '/groups/[id]/manage',
  '/u/[handle]/new',
]

const CORE_LANG_ROUTES = ['/', '/rankings', '/trader/soul', '/hot', '/pricing', '/search?q=btc']
const LANGS = ['en', 'zh', 'ja', 'ko']

// 已知可忽略的网络错误（第三方/预期 4xx）
const NETWORK_WHITELIST = [
  /google-analytics|googletagmanager|sentry|vitals\.vercel|stripe\.com|privy/,
  /\/api\/auth\/.*40[13]/, // 未登录 401/403 是预期
  /\/api\/(user|notifications|watchlist|favorites|subscription).*40[13]/,
]

function isWhitelisted(line) {
  return NETWORK_WHITELIST.some((re) => re.test(line))
}

async function dismissOverlays(page) {
  // cookie 同意
  for (const text of ['OK', '同意', 'Accept']) {
    const btn = page.locator(`button:has-text("${text}")`).first()
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click({ timeout: 1000 }).catch(() => {})
    }
  }
}

function attachCollectors(page, bucket) {
  page.on('pageerror', (e) => bucket.pageErrors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.consoleErrors.push(m.text().slice(0, 300))
  })
  page.on('response', (r) => {
    if (r.status() >= 400) {
      const line = `${r.status()} ${r.request().method()} ${r.url()}`
      if (!isWhitelisted(line)) bucket.httpErrors.push(line.slice(0, 300))
    }
  })
}

async function checkPageHealth(page) {
  const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
  return {
    errorBoundary: /Something went wrong|出错了|页面加载失败/.test(body),
    blank: body.replace(/\s/g, '').length < 50,
    notFound: /404|This page could not be found/.test(body) && body.length < 600,
  }
}

async function interactionPass(page, route, bucket) {
  const tryClick = async (locator, label) => {
    try {
      const el = locator.first()
      if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) return false
      await el.click({ timeout: 2000 })
      await page.waitForTimeout(600)
      bucket.interactions.push(`OK ${label}`)
      return true
    } catch (e) {
      bucket.interactions.push(`FAIL ${label}: ${String(e.message).slice(0, 120)}`)
      return false
    }
  }

  // 周期切换 7D/30D/90D（排行/交易员页）
  for (const period of ['30D', '90D', '7D']) {
    await tryClick(page.getByRole('button', { name: period, exact: true }), `period:${period}`)
  }
  // tab 切换（role=tab 或常见 tab 文案）
  const tabs = page.locator('[role="tab"]')
  const tabCount = await tabs.count().catch(() => 0)
  for (let i = 0; i < Math.min(tabCount, 5); i++) {
    await tryClick(tabs.nth(i), `tab#${i}`)
  }
  // 展开/收起
  await tryClick(page.locator('[aria-expanded="false"]').first(), 'expander')
  // 主题切换（切两次复原）
  const themeBtn = page.locator('[aria-label*="theme" i], [data-testid="theme-toggle"]')
  if (await tryClick(themeBtn, 'theme-toggle')) await tryClick(themeBtn, 'theme-toggle-restore')
  // 搜索框输入回车（仅首页/排行）
  if (route === '/' || route.startsWith('/rankings')) {
    const search = page
      .locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="搜索"]')
      .first()
    if (await search.isVisible({ timeout: 500 }).catch(() => false)) {
      await search.fill('btc').catch(() => {})
      await search.press('Enter').catch(() => {})
      await page.waitForTimeout(1500)
      bucket.interactions.push('OK search-enter')
      await page.goBack().catch(() => {})
    }
  }
}

async function sweepRoute(browser, route, { viewport, lang, interact }) {
  const ctx = await browser.newContext({
    viewport,
    locale: lang === 'zh' ? 'zh-CN' : lang,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaQA',
  })
  const page = await ctx.newPage()
  if (lang) {
    await ctx.addInitScript((l) => {
      try {
        localStorage.setItem('language', l)
        document.cookie = `language=${l};path=/`
      } catch {}
    }, lang)
  }
  const bucket = {
    route,
    viewport: viewport.width,
    lang: lang || 'default',
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    interactions: [],
    health: null,
    loadMs: 0,
  }
  attachCollectors(page, bucket)
  const t0 = Date.now()
  try {
    const resp = await page.goto(`${BASE}${route}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    bucket.status = resp?.status()
    await page.waitForTimeout(5000) // 等水合 + 数据
    bucket.loadMs = Date.now() - t0
    await dismissOverlays(page)
    bucket.health = await checkPageHealth(page)
    if (interact && !bucket.health.errorBoundary && !bucket.health.blank) {
      await interactionPass(page, route, bucket)
      bucket.health = await checkPageHealth(page) // 交互后复查
    }
  } catch (e) {
    bucket.navError = String(e.message).slice(0, 200)
  }
  await ctx.close()
  return bucket
}

function summarize(results) {
  const problems = []
  for (const r of results) {
    const tag = `${r.route} [${r.viewport}px/${r.lang}]`
    if (r.navError) problems.push(`NAV  ${tag}: ${r.navError}`)
    if (r.health?.errorBoundary) problems.push(`CRASH ${tag}: 错误边界出现`)
    if (r.health?.blank) problems.push(`BLANK ${tag}`)
    if (r.health?.notFound) problems.push(`404? ${tag}`)
    for (const e of r.pageErrors) problems.push(`PAGEERR ${tag}: ${e}`)
    for (const e of [...new Set(r.consoleErrors)].slice(0, 3)) problems.push(`CONSOLE ${tag}: ${e}`)
    for (const e of [...new Set(r.httpErrors)].slice(0, 5)) problems.push(`HTTP ${tag}: ${e}`)
    for (const i of r.interactions.filter((x) => x.startsWith('FAIL')))
      problems.push(`INTERACT ${tag}: ${i}`)
  }
  return problems
}

async function main() {
  // 取动态 ID（每个独立 try，单点失败不影响其余；取不到即显式 skip 记录）
  const routes = [...STATIC_ROUTES]
  const skips = [...SKIPPED_AUTH_ROUTES.map((r) => `${r} (需登录态 → auth-sweep)`)]
  const jget = (p) =>
    fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json())
  const addDynamic = async (label, fn) => {
    try {
      const route = await fn()
      if (route) routes.push(route)
      else skips.push(`${label}（API 返回空样本）`)
    } catch (e) {
      skips.push(`${label}（取 ID 失败: ${String(e.message).slice(0, 80)}）`)
    }
  }
  await addDynamic('/post/[id]', async () => {
    const id = (await jget('/api/posts?limit=1'))?.data?.posts?.[0]?.id
    return id && `/post/${id}`
  })
  await addDynamic('/groups/[id]', async () => {
    const id = (await jget('/api/groups?limit=1'))?.data?.groups?.[0]?.id
    return id && `/groups/${id}`
  })
  await addDynamic('/feed/[id]', async () => {
    const id = (await jget('/api/feed?limit=1'))?.data?.activities?.[0]?.id
    return id && `/feed/${id}`
  })
  await addDynamic('/share/rank/[trader_key]', async () => {
    const key = (await jget('/api/rankings?window=30d&limit=1'))?.data?.traders?.[0]?.trader_key
    return key && `/share/rank/${key}`
  })

  const browser = await chromium.launch({ headless: true })
  const results = []

  console.log(`== 扫描 ${routes.length} 路由 × 2 视口 @ ${BASE} ==`)
  for (const route of routes) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      const r = await sweepRoute(browser, route, {
        viewport,
        interact: viewport.width === 1280, // 交互只在桌面跑
      })
      results.push(r)
      const flag = r.health?.errorBoundary || r.pageErrors.length ? ' ⚠️' : ''
      console.log(`  ${route} [${viewport.width}px] ${r.status || 'ERR'} ${r.loadMs}ms${flag}`)
      await new Promise((res) => setTimeout(res, PAGE_DELAY_MS))
    }
  }

  if (LANG_SWEEP) {
    console.log(`== 4 语言 × ${CORE_LANG_ROUTES.length} 核心路径 ==`)
    for (const route of CORE_LANG_ROUTES) {
      for (const lang of LANGS) {
        const r = await sweepRoute(browser, route, {
          viewport: { width: 1280, height: 800 },
          lang,
          interact: false,
        })
        results.push(r)
        const flag = r.health?.errorBoundary || r.pageErrors.length ? ' ⚠️' : ''
        console.log(`  ${route} [${lang}] ${r.status || 'ERR'}${flag}`)
        await new Promise((res) => setTimeout(res, PAGE_DELAY_MS))
      }
    }
  }

  await browser.close()

  const problems = summarize(results)
  const fs = await import('node:fs')
  fs.writeFileSync('/tmp/arena-button-sweep.json', JSON.stringify(results, null, 2))

  console.log(`\n== 结果: ${results.length} 次页面检查, ${problems.length} 个问题 ==`)
  for (const p of problems) console.log(p)
  if (skips.length) {
    console.log(`\n== 显式跳过 ${skips.length} 个动态路由（非静默） ==`)
    for (const s of skips) console.log(`  SKIP ${s}`)
  }
  console.log('\n完整数据: /tmp/arena-button-sweep.json')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
