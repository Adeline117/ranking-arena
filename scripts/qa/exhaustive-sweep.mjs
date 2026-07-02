/**
 * Arena EXHAUSTIVE interaction sweep — clicks EVERY interactive element on
 * every route, not just the first of each kind (the sampling blind spot in
 * button-sweep.mjs / auth-button-sweep.mjs that this tool exists to close).
 *
 * Coverage ledger: every discovered element is written to a JSONL ledger with a
 * fingerprint + click result. The ledger IS the coverage account — a route is
 * "done" only when every non-denied element in it has a recorded outcome.
 *
 * Usage:
 *   node scripts/qa/exhaustive-sweep.mjs                 # anon, prod
 *   BASE_URL=http://localhost:3000 node scripts/qa/exhaustive-sweep.mjs
 *   node scripts/qa/exhaustive-sweep.mjs --auth          # authed (needs /tmp/qa-session.json)
 *   node scripts/qa/exhaustive-sweep.mjs --routes=/,/rankings   # subset
 *   node scripts/qa/exhaustive-sweep.mjs --max-per-route=200    # cap (logged, never silent)
 *
 * Safety: destructive/irreversible controls (logout, delete, pay, disconnect,
 * dissolve group, remove, unsubscribe…) are matched by DENYLIST and SKIPPED
 * (recorded as `denied`, never clicked). Any confirm() dialog is auto-dismissed
 * (cancel). In --auth mode, WRITE controls (follow/like/bookmark/comment/post/
 * tip/subscribe/vote/claim) are ALSO denied — a real session makes those mutate
 * production + notify real users. Authed write-flow testing must go through
 * auth-button-sweep's scripted self-cleaning flows, NOT this blind clicker.
 * Anon mode clicks writes freely (they only open a login modal — safe + useful).
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const AUTH = process.argv.includes('--auth')
const ROUTES_ARG = (process.argv.find((a) => a.startsWith('--routes=')) || '').split('=')[1]
const MAX_PER_ROUTE = Number(
  (process.argv.find((a) => a.startsWith('--max-per-route=')) || '').split('=')[1] || 300
)
const LEDGER_PATH = process.env.QA_LEDGER || 'scripts/qa/.exhaustive-ledger.jsonl'

// Interactive-element selector — the universe we must cover on each route.
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Destructive / irreversible / billing controls — NEVER click. Matched
// case-insensitively against text + aria-label + href + name/id.
const DENYLIST = [
  /log\s?out|sign\s?out|登出|注销|退出登录/i,
  /delete|remove|删除|移除|清空|clear all/i,
  /disconnect|unlink|解绑|断开/i,
  /dissolve|disband|解散|leave group|退出群/i,
  /unsubscribe|cancel\s?(subscription|plan)|取消订阅|退订/i,
  /\bpay\b|checkout|purchase|结账|支付|付款|upgrade now/i,
  /deactivate|close account|注销账户|停用/i,
  /block|report|拉黑|举报/i,
  /reset|revoke|吊销|重置密码/i,
  /transfer|withdraw|提现|转账/i,
]

// Write/mutation controls — denied in --auth mode ONLY. In anon mode these are
// SAFE to click (they open a login modal, which is valuable coverage), but when
// a real session is injected, blindly clicking them mutates production state as
// the QA user AND fires notifications to real users. Authed write-flow testing
// must go through auth-button-sweep's scripted self-cleaning flows instead —
// never through this blind clicker.
const WRITE_ACTION_PATTERNS = [
  /follow|关注|取关/i,
  /\blike\b|点赞|reaction|react/i,
  /bookmark|save\b|收藏|保存/i,
  /repost|转发|quote/i,
  /comment|reply|评论|回复|发布|post\b|send|发送/i,
  /tip|打赏|donate/i,
  /subscribe|订阅|join\b|加入|apply|申请/i,
  /vote|投票/i,
  /claim|认领|verify|验证/i,
]

// Following links off-site or to auth-provider flows would derail the sweep.
const NAV_DENY_HREF = [
  /^https?:\/\/(?!www\.arenafi\.org|localhost)/i, // external origins
  /\/(logout|auth\/callback|api\/)/i,
  /^mailto:|^tel:/i,
]

const NETWORK_WHITELIST = [
  /google-analytics|googletagmanager|sentry|vitals\.vercel|stripe\.com|privy|posthog|plausible/,
  /\/api\/auth\/.*40[13]/,
  /\/api\/(user|notifications|watchlist|favorites|subscription|presence).*40[13]/,
]

const ANON_ROUTES = [
  '/',
  '/rankings',
  '/rankings/tokens',
  '/rankings/bots',
  '/rankings/exchanges',
  '/rankings/weekly',
  '/trader/soul',
  '/hot',
  '/feed',
  '/search?q=btc',
  '/compare',
  '/market',
  '/market/funding-rates',
  '/market/open-interest',
  '/groups',
  '/groups/apply',
  '/competitions',
  '/flash-news',
  '/quiz',
  '/pricing',
  '/referral',
  '/login',
  '/onboarding',
  '/reset-password',
  '/learn',
  '/learn/how-arena-score-works',
  '/methodology',
  '/help',
  '/status',
  '/about',
  '/privacy',
  '/terms',
  '/disclaimer',
  '/dmca',
  '/rankings/tokens/BTC',
  '/s/BTC',
  '/hashtag/btc',
  '/exchange/binance',
  '/wrapped/soul',
  '/u/arena_bot',
]

// Auth-only surfaces worth exhaustive coverage once a session is injected.
const AUTH_EXTRA_ROUTES = [
  '/notifications',
  '/settings',
  '/settings/linked-accounts',
  '/watchlist',
  '/favorites',
  '/portfolio',
  '/following',
  '/messages',
  '/inbox',
  '/my-posts',
  '/user-center',
]

function isWhitelisted(url) {
  return NETWORK_WHITELIST.some((re) => re.test(url))
}

function isDenied(desc) {
  const hay = `${desc.text} ${desc.ariaLabel} ${desc.name} ${desc.id} ${desc.href}`
  if (DENYLIST.some((re) => re.test(hay))) return 'denylist'
  // In authed mode, also refuse write/mutation controls so the sweep never
  // creates follows/likes/posts as the QA user or notifies real users.
  if (AUTH && WRITE_ACTION_PATTERNS.some((re) => re.test(hay))) return 'write-deny'
  if (desc.href && NAV_DENY_HREF.some((re) => re.test(desc.href))) return 'nav-deny'
  return null
}

async function injectIndices(page) {
  // Tag every interactive element with a stable sequential index in document
  // order + return a fingerprint per element. On a deterministic fresh load the
  // same order reproduces, so we can re-locate by [data-qa-idx] after navigation.
  return page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel))
    const out = []
    els.forEach((el, i) => {
      el.setAttribute('data-qa-idx', String(i))
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      out.push({
        idx: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.value || '').trim().slice(0, 80),
        ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 80),
        name: (el.getAttribute('name') || '').slice(0, 40),
        id: (el.id || '').slice(0, 40),
        href: el.getAttribute('href') || '',
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none',
      })
    })
    return out
  }, INTERACTIVE_SELECTOR)
}

function fingerprint(desc) {
  return `${desc.tag}|${desc.type}|${desc.role}|${desc.text}|${desc.ariaLabel}|${desc.href}`
}

async function hydrate(page, route) {
  const resp = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(4000) // hydration + first data
  // dismiss cookie/consent overlays that would eat clicks
  for (const txt of ['OK', '同意', 'Accept', 'Got it']) {
    const btn = page.locator(`button:has-text("${txt}")`).first()
    if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
      await btn.click({ timeout: 800 }).catch(() => {})
    }
  }
  return resp?.status()
}

async function sweepRoute(page, route, ledger, counters) {
  const status = await hydrate(page, route)
  const routeUrl = new URL(`${BASE}${route}`).pathname
  let descs = await injectIndices(page)
  const total = descs.length
  const cap = Math.min(total, MAX_PER_ROUTE)
  if (total > MAX_PER_ROUTE) {
    console.log(
      `  ⚠ ${route}: ${total} elements > cap ${MAX_PER_ROUTE} — ${total - cap} NOT tested (logged)`
    )
  }
  console.log(`  ${route} [${status}] — ${total} interactive elements (testing ${cap})`)

  for (let i = 0; i < cap; i++) {
    const desc = descs[i]
    if (!desc) continue
    const record = {
      route,
      idx: i,
      fp: fingerprint(desc),
      text: desc.text,
      ariaLabel: desc.ariaLabel,
      href: desc.href,
      tag: desc.tag,
      status: null,
      errors: [],
    }

    const denied = isDenied(desc)
    if (denied) {
      record.status = `denied:${denied}`
      counters.denied++
      ledger.push(record)
      continue
    }
    if (!desc.visible || desc.disabled) {
      record.status = desc.disabled ? 'skip:disabled' : 'skip:hidden'
      counters.skipped++
      ledger.push(record)
      continue
    }

    // Internal navigation links: record the target as covered WITHOUT clicking.
    // Physically clicking every link forces a 4s re-hydrate each and turns a
    // route into an hours-long crawl — and the link targets are themselves in
    // the route set (or reachable), so coverage is not lost. We still click
    // non-link controls (buttons/tabs/toggles) since those mutate in-page state.
    if (desc.tag === 'a' && /^\/(?!\/)/.test(desc.href)) {
      record.status = `link:${desc.href}`
      counters.links++
      ledger.push(record)
      continue
    }

    // Reset error buckets for this single interaction.
    const bucket = { pageErrors: [], consoleErrors: [], httpErrors: [] }
    counters._bucket = bucket

    const el = page.locator(`[data-qa-idx="${i}"]`).first()
    const beforeUrl = page.url()
    try {
      if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) {
        record.status = 'skip:vanished'
        counters.skipped++
        ledger.push(record)
        continue
      }
      // For text inputs, type a probe instead of clicking (covers form fields).
      if (desc.tag === 'input' && /text|search|email|url|number|tel|password|/.test(desc.type)) {
        await el.fill('qa-probe').catch(() => {})
        await el.press('Escape').catch(() => {})
        record.status = 'ok:filled'
      } else {
        await el.click({ timeout: 2500 })
        await page.waitForTimeout(500)
        record.status = 'ok:clicked'
      }
      counters.clicked++
    } catch (e) {
      // A click timeout (e.g. off-screen a11y skip-links) is an interaction
      // failure, NOT an app error — keep it in its own field so it doesn't
      // pollute the real-error signal.
      record.status = 'fail:click'
      record.clickError = String(e.message).split('\n')[0].slice(0, 160)
      counters.failed++
    }

    // Collect genuine app errors this interaction produced (console/page/http).
    record.errors.push(...bucket.pageErrors.map((m) => `pageerror: ${m}`))
    record.errors.push(...bucket.consoleErrors.map((m) => `console: ${m}`))
    record.errors.push(...bucket.httpErrors.map((m) => `http: ${m}`))
    if (record.errors.length) counters.withErrors++
    ledger.push(record)

    // Recover navigation / modal state before the next element.
    const afterUrl = page.url()
    const navigated = new URL(afterUrl).pathname !== routeUrl
    if (navigated) {
      record.status += `→nav:${new URL(afterUrl).pathname}`
      await hydrate(page, route)
      descs = await injectIndices(page) // re-tag fresh DOM
    } else {
      // Close any modal/menu the click opened so it doesn't shroud siblings.
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(150)
    }
  }
}

async function buildAuthContext(browser) {
  const session = JSON.parse(fs.readFileSync('/tmp/qa-session.json', 'utf8'))
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaQA',
  })
  await ctx.addInitScript((sess) => {
    try {
      localStorage.setItem('arena-auth', JSON.stringify(sess))
    } catch {}
  }, session)
  const projectRef = 'iknktzifjdyujdccyhsv'
  const host = new URL(BASE).hostname
  const cookieDomain = host === 'localhost' ? 'localhost' : '.arenafi.org'
  const CSRF = `${Date.now().toString(36)}.${Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`
  await ctx.addCookies([
    {
      name: `sb-${projectRef}-auth-token`,
      value: encodeURIComponent(JSON.stringify(session)),
      domain: cookieDomain,
      path: '/',
    },
    {
      name: `sb-${projectRef}-auth-token.0`,
      value: Buffer.from(JSON.stringify(session)).toString('base64'),
      domain: cookieDomain,
      path: '/',
    },
    { name: 'csrf-token', value: CSRF, domain: cookieDomain, path: '/' },
  ])
  return ctx
}

async function main() {
  const routes = ROUTES_ARG
    ? ROUTES_ARG.split(',')
    : AUTH
      ? [...ANON_ROUTES, ...AUTH_EXTRA_ROUTES]
      : ANON_ROUTES

  console.log(`Exhaustive sweep — ${AUTH ? 'AUTH' : 'anon'} — ${BASE} — ${routes.length} routes`)
  const browser = await chromium.launch({ headless: true })
  const ctx = AUTH
    ? await buildAuthContext(browser)
    : await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaQA',
      })

  // Auto-cancel every confirm/beforeunload dialog — the destructive backstop.
  ctx.on('page', (p) => p.on('dialog', (d) => d.dismiss().catch(() => {})))

  const counters = {
    clicked: 0,
    filled: 0,
    links: 0,
    denied: 0,
    skipped: 0,
    failed: 0,
    withErrors: 0,
    _bucket: null,
  }
  // Collectors are attached per-page so a recreated page (after a crash) still
  // reports errors. Returns a fresh page with listeners wired.
  const newTrackedPage = async () => {
    const p = await ctx.newPage()
    p.on('pageerror', (e) => counters._bucket?.pageErrors.push(e.message.slice(0, 200)))
    p.on('console', (m) => {
      if (m.type() === 'error') counters._bucket?.consoleErrors.push(m.text().slice(0, 200))
    })
    p.on('response', (r) => {
      if (r.status() >= 400 && !isWhitelisted(r.url())) {
        counters._bucket?.httpErrors.push(
          `${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 200)
        )
      }
    })
    return p
  }
  let page = await newTrackedPage()

  const ledger = []
  for (const route of routes) {
    try {
      await sweepRoute(page, route, ledger, counters)
    } catch (e) {
      console.log(`  ✗ ${route}: ${String(e.message).slice(0, 160)}`)
      ledger.push({
        route,
        idx: -1,
        status: 'fail:route',
        errors: [String(e.message).slice(0, 200)],
      })
      // A route failure (esp. ERR_ABORTED) can leave the page/context wedged so
      // every subsequent goto aborts too. Recreate the page to recover so one
      // bad route doesn't sink the rest of the sweep.
      try {
        if (!page.isClosed()) await page.close().catch(() => {})
        page = await newTrackedPage()
      } catch {
        /* if we can't recreate, the next iteration's goto will record its own failure */
      }
    }
  }

  await browser.close()

  fs.writeFileSync(LEDGER_PATH, ledger.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const errored = ledger.filter((r) => r.errors && r.errors.length)
  console.log('\n=== Ledger summary ===')
  console.log(`  elements recorded : ${ledger.length}`)
  console.log(`  clicked/filled    : ${counters.clicked}`)
  console.log(`  links recorded    : ${counters.links}`)
  console.log(`  denied (safety)   : ${counters.denied}`)
  console.log(`  skipped (hid/dis) : ${counters.skipped}`)
  console.log(`  click failures    : ${counters.failed}`)
  console.log(`  elements w/ errors: ${counters.withErrors}`)
  console.log(`  ledger → ${LEDGER_PATH}`)
  if (errored.length) {
    console.log('\n=== Elements that produced errors (first 25) ===')
    for (const r of errored.slice(0, 25)) {
      console.log(`  ${r.route} #${r.idx} "${r.text || r.ariaLabel || r.href}" [${r.status}]`)
      for (const e of r.errors.slice(0, 2)) console.log(`      ${e}`)
    }
  }
  // Non-zero exit if genuine app errors surfaced (not mere click-fails on
  // transient overlays), so CI can gate on it.
  const realErrors = errored.filter((r) =>
    r.errors.some((e) => e.startsWith('pageerror:') || e.startsWith('http: 5'))
  )
  process.exit(realErrors.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
