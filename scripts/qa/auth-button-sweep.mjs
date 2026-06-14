/**
 * Arena 登录态按钮/写操作测试（QA 专用账号）
 *
 * 前置: /tmp/qa-session.json — Supabase password grant 响应
 *   (qa.button.test@arenafi.org，见 memory/qa-test-accounts.md)
 *
 * 原则: 每个写操作做完立即反向清理；Stripe 只到 checkout 页为止。
 * 输出: /tmp/arena-auth-sweep.json + 控制台 step 摘要
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const session = JSON.parse(fs.readFileSync('/tmp/qa-session.json', 'utf8'))

const steps = []
let bucket
function newBucket(name) {
  bucket = { step: name, pageErrors: [], consoleErrors: [], httpErrors: [], notes: [] }
  steps.push(bucket)
}
function note(s) {
  bucket.notes.push(s)
  console.log(`    ${s}`)
}

const WHITELIST = [/google-analytics|googletagmanager|sentry|vitals\.vercel|privy|stripe\.com/]

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaQA',
  })
  // 注入 Supabase 会话：
  // 1) localStorage 'arena-auth'（lib/supabase/client.ts storageKey）— 客户端
  // 2) sb-<ref>-auth-token cookie — 服务端（API route / RSC 读 cookie 会话）
  // 3) csrf-token cookie — double-submit CSRF（lib/api/client.ts）
  await ctx.addInitScript((sess) => {
    try {
      localStorage.setItem('arena-auth', JSON.stringify(sess))
    } catch {}
  }, session)
  const projectRef = 'iknktzifjdyujdccyhsv'
  // cookie domain 随 BASE 变（localhost 不能用 .arenafi.org，否则 cookie 不发送）
  const host = new URL(BASE).hostname
  const cookieDomain = host === 'localhost' ? 'localhost' : '.arenafi.org'
  // CSRF 格式（proxy.ts validateTimedCsrfToken）：base36 时间戳 + '.' + 64 hex
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

  const page = await ctx.newPage()
  page.on('pageerror', (e) => bucket?.pageErrors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') bucket?.consoleErrors.push(m.text().slice(0, 300))
  })
  page.on('response', (r) => {
    if (r.status() >= 400 && !WHITELIST.some((re) => re.test(r.url()))) {
      bucket?.httpErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 250))
    }
  })

  const apiHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
    'x-csrf-token': CSRF, // 与 csrf-token cookie double-submit 配对
  }
  // 页面内 fetch（带 CSRF/session 上下文）
  const apiCall = (path, init) =>
    page.evaluate(
      async ({ path, init }) => {
        const res = await fetch(path, init)
        let body = null
        try {
          body = await res.json()
        } catch {}
        return { status: res.status, body }
      },
      { path, init }
    )

  const goto = async (path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(4000)
  }

  // ---------- Step 1: 会话生效 ----------
  newBucket('1-session-active')
  await goto('/')
  // 精确判定：顶栏内的登录入口（避免匹配到正文里的 "Log in to ..." CTA）
  const headerLogin = await page
    .locator('header a[href="/login"], nav a[href="/login"]')
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false)
  const sessionState = await page.evaluate(() => {
    try {
      const s = JSON.parse(localStorage.getItem('arena-auth') || 'null')
      return s?.user?.email || null
    } catch {
      return null
    }
  })
  note(
    `localStorage 会话: ${sessionState || '无'} | 顶栏登录按钮: ${headerLogin ? '可见(FAIL)' : '不可见(OK)'}`
  )

  // ---------- Step 2: 关注/取关（用排行榜第一名的活 trader）----------
  newBucket('2-follow-unfollow')
  let traderPath = '/trader/soul'
  try {
    // 页面内 fetch（Node UA 会被 WAF 拦 Forbidden）
    const rk = await apiCall('/api/rankings?window=30d&limit=1', { method: 'GET' })
    const t0r = rk?.body?.data?.traders?.[0]
    if (t0r?.trader_key)
      traderPath = `/trader/${encodeURIComponent(t0r.trader_key)}?platform=${t0r.platform}`
  } catch {}
  note(`目标 trader: ${traderPath}`)
  await goto(traderPath)
  const followBtn = page
    .locator('button:has-text("Follow"), button:has-text("关注"), button:has-text("+ Follow")')
    .first()
  if (await followBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await followBtn.click()
    await page.waitForTimeout(2500)
    const unfollowBtn = page
      .locator(
        'button:has-text("Following"), button:has-text("已关注"), button:has-text("Unfollow"), button:has-text("取消关注")'
      )
      .first()
    const followed = await unfollowBtn.isVisible({ timeout: 3000 }).catch(() => false)
    note(followed ? 'OK 关注成功（按钮状态翻转）' : 'FAIL 点击关注后按钮未翻转')
    if (followed) {
      await unfollowBtn.click()
      await page.waitForTimeout(2500)
      const restored = await followBtn.isVisible({ timeout: 3000 }).catch(() => false)
      note(restored ? 'OK 取关成功（已清理）' : 'WARN 取关后按钮未还原 — 需人工确认清理')
    }
  } else {
    note('SKIP 未找到关注按钮')
  }

  // ---------- Step 3: 发帖 → 点赞 → 评论 → 删评论 → 删帖（自包含闭环）----------
  newBucket('3-post-lifecycle')
  let postId = null
  {
    const create = await apiCall('/api/posts', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        title: 'QA automated test post — will be deleted',
        content: '[automated-qa] button audit post lifecycle test. Safe to ignore.',
      }),
    })
    postId = create.body?.data?.post?.id || create.body?.data?.id || null
    note(
      postId
        ? `OK 发帖 ${create.status} id=${postId}`
        : `FAIL 发帖 ${create.status}: ${JSON.stringify(create.body)?.slice(0, 150)}`
    )
  }
  if (postId) {
    await goto(`/post/${postId}`)
    const crashed = await page
      .evaluate(() => /Something went wrong/.test(document.body.innerText))
      .catch(() => false)
    note(crashed ? 'FAIL 帖子详情页崩溃' : 'OK 帖子详情页渲染')

    // UI 点赞
    const likeBtn = page.locator('button[aria-label*="like" i], button[aria-label*="赞"]').first()
    if (await likeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await likeBtn.click()
      await page.waitForTimeout(2000)
      note('OK 点赞按钮可点击')
      await likeBtn.click() // 取消赞
      await page.waitForTimeout(1500)
      note('OK 取消赞（清理）')
    } else {
      const like = await apiCall(`/api/posts/${postId}/like`, {
        method: 'POST',
        headers: apiHeaders,
      })
      note(`API 点赞 ${like.status}`)
      const unlike = await apiCall(`/api/posts/${postId}/like`, {
        method: 'DELETE',
        headers: apiHeaders,
      })
      note(`API 取消赞 ${unlike.status}`)
    }

    // 评论
    const comment = await apiCall(`/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({ content: '[automated-qa] comment test' }),
    })
    const commentId = comment.body?.data?.comment?.id || comment.body?.data?.id || null
    note(
      commentId
        ? `OK 评论 ${comment.status}`
        : `WARN 评论 ${comment.status}: ${JSON.stringify(comment.body)?.slice(0, 120)}`
    )
    if (commentId) {
      const delC = await apiCall(`/api/comments/${commentId}`, {
        method: 'DELETE',
        headers: apiHeaders,
      })
      note(`删评论 ${delC.status}（清理）`)
    }

    // 删帖（清理）
    const del = await apiCall(`/api/posts/${postId}`, { method: 'DELETE', headers: apiHeaders })
    note(`${del.status < 300 ? 'OK' : 'FAIL'} 删帖 ${del.status}（清理）`)
  }

  // ---------- Step 4: watchlist 加/移除 ----------
  newBucket('4-watchlist')
  await goto('/s/BTC')
  const watchBtn = page
    .locator(
      'button[aria-label*="watchlist" i], button:has-text("Watchlist"), button[aria-label*="自选"], button:has-text("自选")'
    )
    .first()
  if (await watchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await watchBtn.click()
    await page.waitForTimeout(2000)
    note('OK watchlist 按钮可点（加入）')
    await watchBtn.click()
    await page.waitForTimeout(1500)
    note('OK watchlist 再点（移除/清理）')
  } else {
    note('SKIP 未找到 watchlist 按钮')
  }

  // ---------- Step 5: Pro 门控（free 账号应见 paywall）----------
  newBucket('5-pro-gating')
  await goto('/compare')
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '')
  const hasPaywallOrContent = /Pro|升级|Upgrade|compare|对比/i.test(bodyText)
  const crashed5 = /Something went wrong/.test(bodyText)
  note(
    crashed5
      ? 'FAIL /compare 崩溃'
      : hasPaywallOrContent
        ? 'OK /compare 渲染（paywall 或内容）'
        : 'WARN /compare 内容异常'
  )

  // ---------- Step 6: Stripe 到 checkout 为止 ----------
  newBucket('6-stripe-checkout')
  await goto('/pricing')
  const subBtn = page
    .locator(
      'button:has-text("Subscribe"), button:has-text("订阅"), button:has-text("Get Pro"), button:has-text("Upgrade")'
    )
    .first()
  if (await subBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    const [maybePopup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
      subBtn.click(),
    ])
    await page.waitForTimeout(5000)
    const target = maybePopup || page
    const url = target.url()
    const reachedCheckout = /checkout\.stripe\.com|\/pricing/.test(url)
    note(
      `订阅按钮点击 → ${url.slice(0, 90)} ${reachedCheckout ? '(OK 到达 checkout/留在定价页)' : '(WARN 意外跳转)'}`
    )
    if (maybePopup) await maybePopup.close().catch(() => {})
  } else {
    note('SKIP 未找到订阅按钮')
  }

  // ---------- Step 7: 通知页 + 设置页 ----------
  newBucket('7-notifications-settings')
  await goto('/notifications')
  const nText = await page.evaluate(() => document.body.innerText).catch(() => '')
  note(/Something went wrong/.test(nText) ? 'FAIL /notifications 崩溃' : 'OK /notifications 渲染')
  await goto('/settings')
  const sText = await page.evaluate(() => document.body.innerText).catch(() => '')
  note(/Something went wrong/.test(sText) ? 'FAIL /settings 崩溃' : 'OK /settings 渲染')

  // ---------- Step 8: 社交旅程 — 群组 + inbox + messages + feed ----------
  newBucket('8-social-journey')
  const renderCheck = async (path, label) => {
    await goto(path)
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '')
    const crashed = /Something went wrong|出错了|页面加载失败/.test(txt)
    const blank = txt.replace(/\s/g, '').length < 30
    note(crashed ? `FAIL ${label} 崩溃` : blank ? `WARN ${label} 空白` : `OK ${label} 渲染`)
    return !crashed && !blank
  }
  await renderCheck('/groups', '群组列表')
  // 进第一个群组详情（/groups/[id]）
  try {
    const g = await apiCall('/api/groups?limit=1', { method: 'GET' })
    const gid = g?.body?.data?.groups?.[0]?.id
    if (gid) await renderCheck(`/groups/${gid}`, '群组详情')
    else note('SKIP 无群组样本')
  } catch (e) {
    note(`SKIP 群组详情取 ID 失败: ${String(e.message).slice(0, 60)}`)
  }
  await renderCheck('/inbox', 'inbox')
  await renderCheck('/messages', '私信列表')
  await renderCheck('/feed', 'feed 动态')
  await renderCheck('/following', '关注列表')

  // ---------- Step 9: 账号管理 — 资料编辑 + 收藏增删 ----------
  newBucket('9-account-journey')
  await renderCheck('/user-center', '个人中心')
  await renderCheck('/my-posts', '我的帖子')
  await renderCheck('/portfolio', '组合')
  // 收藏夹（/favorites）渲染检查
  await renderCheck('/favorites', '收藏夹')
  await renderCheck('/settings/linked-accounts', '设置-关联账号')
  // 注：资料编辑（bio/头像）由 settings 页经 supabase client 直写，无独立 REST
  // 端点，UI 写测在 button-sweep 交互层覆盖；此处仅做页面渲染健康检查。

  // ---------- Step 10: 交易所授权旅程（只到授权页，不真实绑定）----------
  newBucket('10-exchange-auth-journey')
  await renderCheck('/exchange/auth', '交易所授权入口')
  await renderCheck('/exchange/auth/api-key', 'API key 授权')
  await renderCheck('/claim', 'claim 入口')
  await renderCheck('/trader/authorize', '交易员认证')
  await renderCheck('/settings/linked-accounts', '关联账号')

  await browser.close()

  fs.writeFileSync('/tmp/arena-auth-sweep.json', JSON.stringify(steps, null, 2))
  console.log('\n== 摘要 ==')
  for (const s of steps) {
    const errs = s.pageErrors.length + s.httpErrors.length
    console.log(
      `${s.step}: ${s.notes.join(' | ')}${errs ? ` [${s.pageErrors.length} pageerr, ${s.httpErrors.length} http]` : ''}`
    )
    for (const e of [...new Set(s.httpErrors)].slice(0, 4)) console.log(`   HTTP ${e}`)
    for (const e of s.pageErrors.slice(0, 2)) console.log(`   PAGEERR ${e}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
