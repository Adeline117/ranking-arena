/**
 * Arena EXHAUSTIVE interaction sweep — clicks EVERY interactive element on
 * every route, not just the first of each kind (the sampling blind spot in
 * button-sweep.mjs / auth-button-sweep.mjs that this tool exists to close).
 *
 * Coverage ledger: every discovered element is written to a JSONL ledger with a
 * fingerprint + click result. The ledger IS the coverage account — a route is
 * "done" only when every non-denied element in it has a recorded outcome.
 *
 * STALENESS: every record carries `ts` (capture time, ISO). The ledger is a
 * point-in-time snapshot of PRODUCTION — before treating an errored record as
 * a live bug, compare its `ts` against the fix/deploy timeline and re-verify
 * live. (2026-07-02 lesson: a scan finished at 18:46, the X-OAuth gating fix
 * landed at 18:51, and the pre-fix 400 records were later re-reported as a
 * live bug. Records without `ts` predate this patch — treat as stale.)
 *
 * Usage:
 *   node scripts/qa/exhaustive-sweep.mjs                 # anon, prod
 *   BASE_URL=http://localhost:3000 node scripts/qa/exhaustive-sweep.mjs
 *   node scripts/qa/exhaustive-sweep.mjs --auth          # authed (needs /tmp/qa-session.json)
 *   node scripts/qa/exhaustive-sweep.mjs --routes=/,/rankings   # subset
 *   node scripts/qa/exhaustive-sweep.mjs --max-per-route=200    # cap (logged, never silent)
 *
 * Safety: every app/Supabase mutation is blocked at the browser network layer
 * and fails the run. Destructive/irreversible controls (logout, delete, pay, disconnect,
 * dissolve group, remove, unsubscribe…) are matched by DENYLIST and SKIPPED
 * (recorded as `denied`, never clicked). Any confirm() dialog is auto-dismissed
 * (cancel). In --auth mode, WRITE controls (follow/like/bookmark/comment/post/
 * tip/subscribe/vote/claim) are ALSO denied — a real session makes those mutate
 * production + notify real users. Authed write-flow testing must go through
 * auth-button-sweep's scripted self-cleaning flows, NOT this blind clicker.
 * Anon mode may still click write-shaped UI to cover its login prompt, but any
 * outgoing product mutation is aborted before it reaches the server.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readEnv, qaAuthStatus } from './qa-auth.mjs'
import { installReadOnlyNetworkGuard } from './read-only-network-guard.mjs'
import { exerciseFill } from './input-interaction.mjs'

// axe-core is already present (transitive dep) — inject its bundle and run ONLY
// the color-contrast rule. No new devDep = no package.json/lock churn in the
// shared worktree. Absolute path so cwd surprises (cron) don't break the inject.
const AXE_PATH = fileURLToPath(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url))

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const AUTH = process.argv.includes('--auth')
const SESSION_PATH = '/tmp/qa-session.json'
// Value = everything after the FIRST '=' so query-string routes survive
// (e.g. --routes=/search?q=btc must not truncate at the query's '=').
const flagValue = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`))
  return arg ? arg.slice(name.length + 1) : undefined
}
const ROUTES_ARG = flagValue('--routes')
const MAX_PER_ROUTE = Number(flagValue('--max-per-route') || 300)
const LEDGER_PATH = process.env.QA_LEDGER || 'scripts/qa/.exhaustive-ledger.jsonl'
// --lang=<en|zh|ja|ko>: preset the UI locale (browser locale + language
// localStorage/cookie) so a sweep can run any of the 4 shipped languages.
const LANG = flagValue('--lang') || 'en'
if (!['en', 'zh', 'ja', 'ko'].includes(LANG)) {
  console.error(`✗ --lang must be en|zh|ja|ko (got "${LANG}")`)
  process.exit(2)
}

// i18n key-leak detection basis: the set of real translation keys. A visible
// text node whose whole content EXACTLY equals a multi-segment camelCase key
// (e.g. `flashNews`, `newsBreaking`) is the key rendered instead of its
// translation — a hard i18n bug. Restricting to multi-segment camelCase keys
// (has an internal capital) is what keeps this precise: single-word keys
// (`home`, `search`) could legitimately appear lowercase, camelCase keys never.
function loadI18nKeys() {
  try {
    const src = fs.readFileSync('lib/i18n/en.ts', 'utf8')
    const keys = new Set()
    const re = /^\s*([a-zA-Z0-9_]+):\s*['"`]/gm
    let m
    while ((m = re.exec(src))) {
      if (/[a-z][a-z0-9]*[A-Z]/.test(m[1])) keys.add(m[1])
    }
    return keys
  } catch {
    return new Set()
  }
}
const I18N_KEYS = loadI18nKeys()

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

// Redirect-only routes: the page component renders null and client-redirects
// in a useEffect (async — may fire AFTER hydrate()'s wait). Enumerating
// elements there indexes the transient shell DOM, and every later click fails
// mid-redirect ("Timeout 2500ms exceeded" → fail:click→nav noise; 2026-07-01
// auth ledger had 50+ such phantom records for /my-posts). For these routes we
// only assert the FINAL landing pathname matches the expected pattern — the
// landing page's own elements are covered when the sweep visits it as a route
// (or via the redirect-dedup path below), so element scanning here is pure
// duplication. Value = regex the final pathname must match to pass.
const REDIRECT_ONLY_ROUTES = new Map([
  // /my-posts → /u/<handle> (authed), /login (anon), '/' (authed, no handle
  // yet / social feature-flagged off). app/(app)/my-posts/page.tsx.
  ['/my-posts', /^\/(?:u\/[^/]+|login)?$/],
])

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
        // Standard off-screen a11y pattern (e.g. skip-to-content link:
        // position:absolute left:-9999px, 1x1, moves into viewport onFocus).
        // These are keyboard-reachable by design but un-clickable at rest —
        // Playwright's hit-target check times out on them. Flag separately so
        // the sweep records skip:offscreen-a11y instead of a bogus fail:click.
        offscreenA11y: (rect.width <= 1 && rect.height <= 1) || rect.right <= 0 || rect.bottom <= 0,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          // opacity:0 / pointer-events:none elements (e.g. back-to-top at
          // scrollY=0) are visually hidden and cannot receive clicks —
          // Playwright's hit-target check would time out. Treat as skip:hidden.
          parseFloat(style.opacity) > 0.01 &&
          style.pointerEvents !== 'none',
      })
    })
    return out
  }, INTERACTIVE_SELECTOR)
}

function fingerprint(desc) {
  return `${desc.tag}|${desc.type}|${desc.role}|${desc.text}|${desc.ariaLabel}|${desc.href}`
}

// Playwright buries the DECISIVE failure cause ("<header> subtree intercepts
// pointer events", "element is not stable", "outside of the viewport", …) in
// the call-log lines BELOW the generic first line ("Timeout 2500ms exceeded").
// Keeping only line 1 made every fail:click indistinguishable and forced live
// re-diagnosis. Extract the first cause-bearing line and append it. Call-log
// lines carry ANSI escape codes (\x1b[2m…\x1b[22m) — strip them so the JSONL
// ledger stays clean. (Blindly joining the first N lines is useless: they are
// "waiting for locator(...)" filler.)
const CLICK_CAUSE_PATTERNS = [
  /intercepts pointer events/i,
  /not stable/i,
  /not attached/i,
  /outside of the viewport/i,
  /element is not visible/i,
  /element is not enabled/i,
]
function summarizeClickError(e) {
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = String(e.message)
    .split('\n')
    .map((l) => stripAnsi(l).trim().replace(/^-\s+/, ''))
    .filter(Boolean)
  const first = lines[0] || 'unknown click error'
  const cause = lines.slice(1).find((l) => CLICK_CAUSE_PATTERNS.some((re) => re.test(l)))
  return (cause ? `${first} — ${cause}` : first).slice(0, 300)
}

// ---------- dead-button detection ----------
// Lightweight page-state snapshot taken immediately before and after a click.
// If NOTHING observable changed (URL, visible text length, open overlays, DOM
// node count) AND the click fired no network request, the control is a dead
// button: clickable but does nothing. Such elements were previously recorded
// ok:clicked, indistinguishable from a working button — the blind spot that let
// "clicked but nothing happens" bugs survive earlier sweeps.
async function snapshotEffect(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body ? document.body.innerText : ''
      // Order-sensitive content hash: a client-side SORT reorders rows without
      // changing total text LENGTH, so a length-only check false-flags working
      // sort headers as dead. A djb2 hash of the ordered text changes on reorder,
      // so a working sort registers as an effect. (Live-data pages mutate text on
      // a ~30s timer, but the ~2s click window rarely coincides — occasional
      // background mutation → "has effect" → misses a true dead button, which is
      // the safe direction for a non-gating signal.)
      let h = 5381
      for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
      return {
        url: location.href,
        textLen: text.length,
        textHash: h,
        overlays: document.querySelectorAll(
          '[role="dialog"],[aria-modal="true"],[data-state="open"]'
        ).length,
        nodes: document.querySelectorAll('*').length,
      }
    })
  } catch {
    // Snapshot taken mid-navigation throws; null → treat as "changed" so a
    // navigating click is never mislabelled dead.
    return null
  }
}

function hasEffect(before, after, reqDelta) {
  if (!before || !after) return true // couldn't measure → never flag as dead
  if (reqDelta > 0) return true // click fired a request → had an effect
  if (before.url !== after.url) return true
  if (before.textHash !== after.textHash) return true // content changed/reordered (catches client-side sort)
  if (Math.abs(before.textLen - after.textLen) > 2) return true // >2 tolerates ticking timestamps/counters
  if (before.overlays !== after.overlays) return true
  if (Math.abs(before.nodes - after.nodes) > 2) return true
  return false
}

// ---------- page-level quality checks (run once per route) ----------
// error-boundary / blank / 404 body-text health (ported from button-sweep) +
// i18n key-leak scan (text node exactly matching a known camelCase key) +
// hard placeholder leaks ([object Object] / undefined / {{…}} / t('…')).
async function pageQualityCheck(page, keys) {
  try {
    return await page.evaluate((keyList) => {
      const keySet = new Set(keyList)
      const body = document.body ? document.body.innerText : ''
      const health = {
        errorBoundary: /Something went wrong|出错了|页面加载失败/.test(body),
        blank: body.replace(/\s/g, '').length < 50,
        notFound:
          /This page could not be found|ページが見つかりません|페이지를 찾을 수 없/.test(body) &&
          body.length < 600,
      }
      const leaks = new Set()
      const root = document.body || document.documentElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node
      let scanned = 0
      while ((node = walker.nextNode()) && scanned < 5000) {
        scanned++
        const t = (node.nodeValue || '').trim()
        if (!t || t.length > 60) continue
        const pe = node.parentElement
        if (!pe) continue
        const tag = pe.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE') continue
        if (t === '[object Object]' || t === 'undefined' || t === 'NaN' || /\{\{.+\}\}/.test(t)) {
          leaks.add(t.slice(0, 40))
        } else if (keySet.has(t)) {
          leaks.add(t.slice(0, 40))
        }
      }
      return { health, leaks: Array.from(leaks).slice(0, 20) }
    }, Array.from(keys))
  } catch {
    return { health: { errorBoundary: false, blank: false, notFound: false }, leaks: [] }
  }
}

// WCAG color-contrast violations via axe-core's engine (the battle-tested
// relative-luminance impl — beats a hand-rolled formula on gradients, alpha,
// and background resolution). Runs ONLY the color-contrast rule, once per route.
async function contrastViolations(page) {
  try {
    await page.addScriptTag({ path: AXE_PATH })
    return await page.evaluate(async () => {
      if (!window.axe) return []
      const res = await window.axe.run(document, {
        runOnly: { type: 'rule', values: ['color-contrast'] },
        resultTypes: ['violations'],
      })
      const nodes = (res.violations[0] && res.violations[0].nodes) || []
      return nodes.slice(0, 15).map((n) => ({
        target: (n.target || []).join(' ').slice(0, 90),
        summary: ((n.any && n.any[0] && n.any[0].message) || n.failureSummary || '')
          .replace(/\s+/g, ' ')
          .slice(0, 140),
      }))
    })
  } catch {
    return []
  }
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

async function sweepRoute(page, route, ledger, counters, sweptPaths) {
  const status = await hydrate(page, route)
  const routeUrl = new URL(`${BASE}${route}`).pathname
  // Redirect-only routes: assert the final landing pathname, record ONE
  // outcome, and skip element enumeration entirely (see REDIRECT_ONLY_ROUTES).
  const redirectRule = REDIRECT_ONLY_ROUTES.get(routeUrl)
  if (redirectRule) {
    // The redirect is a client-side useEffect (session read + profile fetch) —
    // it can land after hydrate()'s fixed wait. Wait for the URL to leave the
    // route, then a short settle for chained replaces (e.g. → /login → final).
    await page
      .waitForURL((u) => new URL(u).pathname !== routeUrl, { timeout: 15000 })
      .catch(() => {})
    await page.waitForTimeout(1000)
    const landedPath = new URL(page.url()).pathname
    const pass = landedPath !== routeUrl && redirectRule.test(landedPath)
    console.log(
      `  ${route} [${status}] — redirect-only route → ${landedPath} (${pass ? 'expected' : 'UNEXPECTED'})`
    )
    ledger.push({
      route,
      idx: -1,
      ts: new Date().toISOString(),
      status: pass ? `redirect-ok:${landedPath}` : `fail:redirect:${landedPath}`,
      finalPath: landedPath,
      errors: pass ? [] : [`redirect-only route landed on ${landedPath}, expected ${redirectRule}`],
    })
    if (pass) counters.redirected++
    else counters.failed++
    // Do NOT return landedPath: the landing page was not enumerated here, so
    // it must stay eligible for a full sweep via its own route / later dedup.
    return null
  }
  // Redirect dedup (2026-07-02): auth-gated routes (/compare, /onboarding, …)
  // client-redirect anonymous visitors to /login. Enumerating that destination
  // under the ORIGINAL route re-attributes the same /login elements to N
  // routes — 1 real finding balloons into N phantom per-route findings.
  // Key by final PATHNAME (not full URL: /login?redirect=/compare and
  // /login?returnUrl=/onboarding differ only in query but are the same page).
  // First landing on a redirect target still enumerates it (coverage kept);
  // later routes redirecting to an already-swept path record one
  // `redirected:` marker and skip.
  const finalPath = new URL(page.url()).pathname
  const redirected = finalPath !== routeUrl
  if (redirected && sweptPaths.has(finalPath)) {
    console.log(`  ${route} [${status}] — redirected→${finalPath} (already swept, deduped)`)
    ledger.push({
      route,
      idx: -1,
      ts: new Date().toISOString(),
      status: `redirected:${finalPath}`,
      finalPath,
      errors: [],
    })
    counters.redirected++
    return finalPath
  }
  if (redirected) {
    console.log(`  ${route} — redirected→${finalPath} (first landing, enumerating destination)`)
  }
  // Page-level quality scan (once per route): body health + i18n key leaks.
  const quality = await pageQualityCheck(page, I18N_KEYS)
  const qErrors = []
  if (quality.health.errorBoundary) qErrors.push('pagehealth: error-boundary rendered')
  if (quality.health.blank) qErrors.push('pagehealth: page body effectively blank')
  for (const lk of quality.leaks) qErrors.push(`i18n-leak: ${lk}`)
  // WCAG color-contrast (once per route, non-gating first-run observe).
  const contrast = await contrastViolations(page)
  if (contrast.length) {
    counters.contrast += contrast.length
    ledger.push({
      route,
      idx: -1,
      ts: new Date().toISOString(),
      status: `a11y:contrast:${contrast.length}`,
      contrast: contrast.slice(0, 15),
      errors: [],
    })
    console.log(
      `  ${route} — a11y contrast: ${contrast.length} node(s) below WCAG threshold (e.g. ${contrast[0].target})`
    )
  }
  if (qErrors.length) {
    counters.quality += quality.leaks.length + (quality.health.errorBoundary ? 1 : 0)
    ledger.push({
      route,
      idx: -1,
      ts: new Date().toISOString(),
      status: quality.health.errorBoundary
        ? 'fail:page-error-boundary'
        : quality.leaks.length
          ? `i18n-leak:${quality.leaks.length}`
          : 'pagehealth:blank',
      leaks: quality.leaks,
      health: quality.health,
      errors: quality.health.errorBoundary ? ['pageerror: error-boundary rendered'] : [],
    })
    console.log(
      `  ${route} — quality: ${qErrors.slice(0, 4).join(' | ')}${qErrors.length > 4 ? ` (+${qErrors.length - 4})` : ''}`
    )
  }

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
      ts: new Date().toISOString(),
      fp: fingerprint(desc),
      text: desc.text,
      ariaLabel: desc.ariaLabel,
      href: desc.href,
      tag: desc.tag,
      status: null,
      errors: [],
    }
    // On redirected routes, stamp the page the element ACTUALLY lives on so
    // downstream consumers can dedupe by finalPath+fp instead of route+fp.
    if (redirected) record.finalPath = finalPath

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
    if (desc.offscreenA11y) {
      // sr-only / off-screen a11y elements (skip links): correct product code,
      // physically un-clickable at rest — not an app failure.
      record.status = 'skip:offscreen-a11y'
      counters.skipped++
      ledger.push(record)
      continue
    }

    // Pure in-page anchors (e.g. skip-to-content `<a href="#main-content">`)
    // don't mutate app state and are keyboard-focus patterns — record without
    // clicking, mirroring the internal-link branch below.
    if (desc.tag === 'a' && desc.href.startsWith('#')) {
      record.status = 'skip:anchor-link'
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
    const bucket = { pageErrors: [], consoleErrors: [], httpErrors: [], reqCount: 0 }
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
      // Fill only controls whose HTML type accepts text. Type-specific probes
      // keep browser validation meaningful; checkbox/radio/file controls stay
      // on the click path. A rejected fill is a real coverage failure.
      const fillResult = await exerciseFill(el, desc)
      if (fillResult.handled) {
        if (fillResult.ok) {
          record.status = 'ok:filled'
          counters.filled++
        } else {
          record.status = 'fail:fill'
          record.fillError = fillResult.error
          counters.failed++
        }
      } else {
        const before = await snapshotEffect(page)
        const reqBefore = bucket.reqCount
        await el.click({ timeout: 2500 })
        // Next client navigation is asynchronous: a button can schedule
        // router.push() after its own click handler has returned. The former
        // 400ms settle was short enough for /help's ContactSupportButton to
        // navigate to /login *between* interactions, making the following
        // Feedback button look blocked by the login page overlay. Wait for a
        // short, explicit SPA-navigation window before recording the effect;
        // the recovery block below then immediately re-hydrates this route.
        await page.waitForURL((url) => url.href !== beforeUrl, { timeout: 1000 }).catch(() => {})
        // Give async handlers time to fire a request or mutate the DOM before
        // judging effect: settle on networkidle, then a short floor for pure
        // client-side state changes that never touch the network.
        await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {})
        await page.waitForTimeout(400)
        const after = await snapshotEffect(page)
        const effective = hasEffect(before, after, bucket.reqCount - reqBefore)
        record.status = effective ? 'ok:clicked' : 'dead:no-effect'
        if (!effective) {
          counters.dead++
          // Keep the raw before/after so a human can tell a true dead button
          // from a legit no-op (e.g. re-clicking an already-active tab).
          record.effect = { before, after, reqDelta: bucket.reqCount - reqBefore }
        }
        counters.clicked++
      }
    } catch (e) {
      // Live-data surfaces re-render on a timer (e.g. /market SectorTreemap:
      // spot data refetches every 30s and re-lays-out the squarified tiles),
      // so an element that passed the isVisible pre-check can DETACH before
      // the click lands — the [data-qa-idx] locator then matches nothing and
      // times out. That is a tool artifact, not an app failure: if the tagged
      // element is gone at failure time, record skip:vanished, not fail:click.
      const stillAttached = (await el.count().catch(() => 0)) > 0
      if (!stillAttached) {
        record.status = 'skip:vanished'
        counters.skipped++
      } else {
        // Still attached but the click failed — on those same live surfaces the
        // element can be mid-relayout ("element is not stable") exactly when the
        // click lands. Retry ONCE: the locator re-resolves against the settled
        // layout, so only a repeat failure is a genuine fail:click. (Timeout
        // fires during Playwright's pre-dispatch actionability checks, so the
        // first click never landed — the retry cannot double-fire an action.)
        try {
          await el.click({ timeout: 2500 })
          await page.waitForTimeout(500)
          record.status = 'ok:clicked-retry'
          counters.clicked++
        } catch (e2) {
          // A click timeout (e.g. off-screen a11y skip-links) is an interaction
          // failure, NOT an app error — keep it in its own field so it doesn't
          // pollute the real-error signal.
          record.status = 'fail:click'
          record.clickError = summarizeClickError(e2)
          counters.failed++
        }
      }
    }

    // Collect genuine app errors this interaction produced (console/page/http).
    record.errors.push(...bucket.pageErrors.map((m) => `pageerror: ${m}`))
    record.errors.push(...bucket.consoleErrors.map((m) => `console: ${m}`))
    record.errors.push(...bucket.httpErrors.map((m) => `http: ${m}`))
    if (record.errors.length) counters.withErrors++
    ledger.push(record)

    // Recover navigation / modal state before the next element.
    // Compare against finalPath (the page actually enumerated): on a
    // redirected route, comparing against routeUrl would flag EVERY click as
    // a navigation and force a pointless re-hydrate per element.
    const afterUrl = page.url()
    const navigated = new URL(afterUrl).pathname !== finalPath
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
  return finalPath
}

// ---------------------------------------------------------------------------
// AUTH session lifecycle（2026-07-01 事故根治 — 见 qa-auth.mjs 头注释）
//
// 曾发生：注入的 refresh_token 被并发进程（sentinel cron / 另一 sweep 的
// bootstrap 密码重置）吊销 → 整轮登录态扫描退化为匿名态 → 大规模伪 401/
// 伪 fail:click→nav。三道防线：
//   1. 扫描开始前 preflight `GET /auth/v1/user`，非 200 先重 bootstrap，
//      仍非 200 直接拒跑（绝不带死 session 开扫）。
//   2. 每个路由开始前廉价校验 token；死了就在互斥锁内重 bootstrap（qa-auth
//      持久化密码 → 正常路径不重置密码、不吊销别人的 session）并重建 context。
//   3. taint 判定：路由扫描期间出现 `400 …grant_type=refresh_token` 或
//      `/auth/v1/user` 401/403 → 该路由记录整体作废（不进 ledger），刷新
//      session 后重扫一次；再 taint 则记 fail:tainted，最终 exit 3。
// ---------------------------------------------------------------------------

function isSessionKillSignal(status, url) {
  return (
    (status === 400 &&
      url.includes('/auth/v1/token') &&
      url.includes('grant_type=refresh_token')) ||
    ((status === 401 || status === 403) && url.includes('/auth/v1/user'))
  )
}

async function sessionStatus(supaUrl, anonKey) {
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'))
    return await qaAuthStatus(supaUrl, anonKey, session.access_token)
  } catch {
    return 0
  }
}

// 重 bootstrap 走 bootstrap-qa-session.mjs（其内部经 qa-auth 互斥锁串行，
// 持久化密码优先 — 不会反过来吊销其他并发进程正在用的 session）。
function rebootstrap() {
  execSync('node scripts/qa/bootstrap-qa-session.mjs', { stdio: 'inherit', timeout: 120_000 })
}

// Preset the shipped UI language on a context: browser locale is set at
// newContext time; here we also seed the app's own language localStorage key +
// cookie (mirrors button-sweep) so client i18n picks it up on first paint.
// Returns the context so it can wrap a newContext(...) call inline.
async function applyLang(ctx) {
  if (LANG !== 'en') {
    await ctx.addInitScript((lang) => {
      try {
        localStorage.setItem('language', lang)
      } catch {}
      try {
        document.cookie = `language=${lang}; path=/`
      } catch {}
    }, LANG)
  }
  return ctx
}

async function buildAuthContext(browser) {
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'))
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: LANG,
    serviceWorkers: 'block',
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
  const supaUrl = AUTH ? readEnv('NEXT_PUBLIC_SUPABASE_URL') : null
  const anonKey = AUTH ? readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY') : null

  const buildContext = async () =>
    applyLang(
      AUTH
        ? await buildAuthContext(browser)
        : await browser.newContext({
            viewport: { width: 1280, height: 900 },
            locale: LANG,
            serviceWorkers: 'block',
            userAgent:
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaQA',
          })
    )
  let ctx = await buildContext()

  const blockedMutations = []
  let activeRoute = '<startup>'
  // Network denial is the primary safety boundary; dialog dismissal is a
  // second backstop for controls that never reach the network.
  const wireContext = async (c) => {
    await installReadOnlyNetworkGuard(c, {
      baseUrl: BASE,
      supabaseUrl: supaUrl,
      onBlocked: (violation) => {
        blockedMutations.push({
          ...violation,
          route: activeRoute,
          ts: new Date().toISOString(),
        })
      },
    })
    c.on('page', (p) => p.on('dialog', (d) => d.dismiss().catch(() => {})))
  }
  await wireContext(ctx)

  const counters = {
    clicked: 0,
    filled: 0,
    links: 0,
    denied: 0,
    skipped: 0,
    failed: 0,
    dead: 0,
    quality: 0,
    contrast: 0,
    withErrors: 0,
    tainted: 0,
    redirected: 0,
    blockedMutations: 0,
    _bucket: null,
  }
  // Session-kill signals seen during the CURRENT route (AUTH mode) — presence
  // means every result gathered in this route is a session artifact, not an
  // app bug, and must NOT enter the ledger.
  const taintSignals = []
  // Collectors are attached per-page so a recreated page (after a crash) still
  // reports errors. Returns a fresh page with listeners wired.
  const newTrackedPage = async () => {
    const p = await ctx.newPage()
    // Count every request fired during the current interaction — a click that
    // fires none AND changes no DOM/URL is a dead button (see snapshotEffect).
    p.on('request', () => {
      if (counters._bucket) counters._bucket.reqCount++
    })
    p.on('pageerror', (e) => counters._bucket?.pageErrors.push(e.message.slice(0, 200)))
    p.on('console', (m) => {
      if (m.type() === 'error') counters._bucket?.consoleErrors.push(m.text().slice(0, 200))
    })
    p.on('response', (r) => {
      if (AUTH && isSessionKillSignal(r.status(), r.url())) {
        taintSignals.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 200))
      }
      if (r.status() >= 400 && !isWhitelisted(r.url())) {
        counters._bucket?.httpErrors.push(
          `${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 200)
        )
      }
    })
    return p
  }
  let page = await newTrackedPage()

  // Rebuild the ENTIRE context (not just the page) after a session refresh —
  // cookies + localStorage init-script hold the old, now-revoked tokens.
  const refreshAuthedContext = async () => {
    await ctx.close().catch(() => {})
    ctx = await buildContext()
    await wireContext(ctx)
    page = await newTrackedPage()
  }

  // Validate token; on 401/403/parse-failure re-bootstrap (serialized via the
  // qa-auth mutex — never kills sessions other processes are using) and
  // rebuild the browser context. Returns true iff a live session is injected.
  const ensureLiveSession = async () => {
    let st = await sessionStatus(supaUrl, anonKey)
    if (st === 200) return true
    console.log(`  ⚠ QA session dead (auth/v1/user → ${st}) — re-bootstrapping`)
    try {
      rebootstrap()
    } catch (e) {
      console.log(`  ✗ re-bootstrap failed: ${String(e.message).slice(0, 160)}`)
      return false
    }
    await refreshAuthedContext()
    st = await sessionStatus(supaUrl, anonKey)
    return st === 200
  }

  // Preflight（拒跑闸门）: never START a sweep on a dead session — that is how
  // an entire authed run silently degrades to anon and floods the ledger with
  // fake 401s. One bootstrap attempt is allowed; still dead → refuse to run.
  if (AUTH) {
    if (!(await ensureLiveSession())) {
      console.error(
        '✗ 拒跑: QA session invalid and re-bootstrap could not revive it (auth/v1/user ≠ 200)'
      )
      await browser.close()
      process.exit(2)
    }
    const bootedAt = (() => {
      try {
        return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8')).qa_bootstrap_at || 'unknown'
      } catch {
        return 'unknown'
      }
    })()
    console.log(`Preflight OK — QA session live (bootstrapped at ${bootedAt})`)
  }

  const ledger = []
  // Pathnames already enumerated this run — used to dedupe auth-gate redirect
  // targets (see sweepRoute). Populated only AFTER a route survives the taint
  // gate, so a voided attempt never marks its landing page as covered.
  const sweptPaths = new Set()
  for (const route of routes) {
    activeRoute = route
    if (AUTH && !(await ensureLiveSession())) {
      ledger.push({
        route,
        idx: -1,
        ts: new Date().toISOString(),
        status: 'fail:auth-dead',
        errors: ['QA session invalid and re-bootstrap failed — route not swept'],
      })
      continue
    }
    let attempt = 0
    for (;;) {
      attempt++
      taintSignals.length = 0
      const ledgerMark = ledger.length
      let sweptFinalPath = null
      try {
        sweptFinalPath = await sweepRoute(page, route, ledger, counters, sweptPaths)
      } catch (e) {
        console.log(`  ✗ ${route}: ${String(e.message).slice(0, 160)}`)
        ledger.push({
          route,
          idx: -1,
          ts: new Date().toISOString(),
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
        break
      }
      // Taint gate: session-kill signals mean everything recorded for this
      // route is an artifact of a dead session, not app behavior. Void those
      // records, refresh the session, re-sweep once.
      if (AUTH && taintSignals.length) {
        const dropped = ledger.splice(ledgerMark)
        counters.tainted++
        console.log(
          `  ☠ ${route}: session-kill signal (${taintSignals[0]}) — ${dropped.length} tainted records voided (attempt ${attempt})`
        )
        if (attempt >= 2 || !(await ensureLiveSession())) {
          ledger.push({
            route,
            idx: -1,
            ts: new Date().toISOString(),
            status: 'fail:tainted',
            errors: taintSignals.slice(0, 3).map((s) => `session-kill: ${s}`),
          })
          break
        }
        continue // retry the route once with a fresh session
      }
      // Only mark the enumerated pathname as covered once the records are
      // final (past the taint gate) — a voided attempt must not suppress a
      // later re-enumeration of the same landing page.
      if (sweptFinalPath) sweptPaths.add(sweptFinalPath)
      break
    }
  }

  await browser.close()

  const uniqueMutations = new Map()
  for (const attempt of blockedMutations) {
    const key = `${attempt.route}|${attempt.method}|${attempt.target}`
    if (!uniqueMutations.has(key)) uniqueMutations.set(key, attempt)
  }
  counters.blockedMutations = uniqueMutations.size
  for (const attempt of uniqueMutations.values()) {
    ledger.push({
      route: attempt.route,
      idx: -1,
      ts: attempt.ts,
      status: 'fail:mutation-blocked',
      method: attempt.method,
      target: attempt.target,
      scope: attempt.scope,
      errors: [`mutation-blocked: ${attempt.method} ${attempt.target}`],
    })
  }

  fs.writeFileSync(LEDGER_PATH, ledger.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const errored = ledger.filter((r) => r.errors && r.errors.length)
  console.log('\n=== Ledger summary ===')
  console.log(`  elements recorded : ${ledger.length}`)
  console.log(`  clicked           : ${counters.clicked}`)
  console.log(`  filled            : ${counters.filled}`)
  console.log(`  links recorded    : ${counters.links}`)
  console.log(`  denied (safety)   : ${counters.denied}`)
  console.log(`  skipped (hid/dis) : ${counters.skipped}`)
  console.log(`  click failures    : ${counters.failed}`)
  console.log(`  dead (no-effect)  : ${counters.dead} (clicked, but no DOM/URL/network change)`)
  console.log(`  quality (i18n/err): ${counters.quality} (i18n-leak + error-boundary findings)`)
  console.log(`  a11y contrast     : ${counters.contrast} (nodes below WCAG contrast, non-gating)`)
  console.log(`  elements w/ errors: ${counters.withErrors}`)
  console.log(`  redirects deduped : ${counters.redirected} (auth-gate → already-swept page)`)
  console.log(`  mutations blocked : ${counters.blockedMutations} (network-denied; run fails)`)
  console.log(
    `  tainted routes    : ${counters.tainted} (session-kill artifacts voided, not in ledger)`
  )
  console.log(`  ledger → ${LEDGER_PATH}`)
  if (errored.length) {
    console.log('\n=== Elements that produced errors (first 25) ===')
    for (const r of errored.slice(0, 25)) {
      console.log(`  ${r.route} #${r.idx} "${r.text || r.ariaLabel || r.href}" [${r.status}]`)
      for (const e of r.errors.slice(0, 2)) console.log(`      ${e}`)
    }
  }
  // Non-zero exit if genuine app errors surfaced (not mere click-fails on
  // transient overlays), so CI can gate on it. exit 3 = auth-taint: results
  // for those routes are session artifacts and MUST NOT be trusted/re-used.
  const authTainted = ledger.filter(
    (r) => r.status === 'fail:tainted' || r.status === 'fail:auth-dead'
  )
  if (authTainted.length) {
    console.error(
      `\n☠ ${authTainted.length} route(s) unresolvably tainted by session death — rerun after fixing auth`
    )
    process.exit(3)
  }
  if (counters.blockedMutations > 0) {
    console.error(
      `\n✗ ${counters.blockedMutations} product mutation(s) were blocked — sweep is not read-only clean`
    )
    process.exit(4)
  }
  const realErrors = errored.filter((r) =>
    r.errors.some((e) => e.startsWith('pageerror:') || e.startsWith('http: 5'))
  )
  process.exit(realErrors.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
