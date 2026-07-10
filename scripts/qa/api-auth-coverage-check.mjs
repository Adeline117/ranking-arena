#!/usr/bin/env node
/**
 * API 鉴权覆盖检查（默认拒绝兜底）— 企业级差距整改 Batch D
 *
 * 背景：无根级 middleware.ts，313+ 个 route 靠各自自觉调用 auth wrapper，
 * "忘加鉴权"是 fail-open 型风险（ENTERPRISE_GAP_ANALYSIS_2026-07.md 差距 #3）。
 * 本检查在 CI 层强制：每个 app/api/⁎⁎/route.ts 要么引用已知 auth 原语，
 * 要么在下方 PUBLIC_API_ROUTES 显式白名单里（公开只读端点）。
 * 两者都不满足 → exit 1 阻断。新增公开 route 必须来这里登记，留下审计痕迹。
 *
 * 用法：node scripts/qa/api-auth-coverage-check.mjs [--list]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const API_DIR = join(ROOT, 'app', 'api')

// 已知 auth 原语（匹配到任意一个即视为"有鉴权意识"——不验证正确性，只防遗忘）
const AUTH_PATTERNS = [
  /\bwithAuth\b/, // lib/api/middleware.ts — 用户鉴权 wrapper
  /\brequireAuth\b/, // lib/supabase/server.ts
  /\bverifyAuth\b/, // lib/api/auth.ts
  /\bwithCron\b/, // lib/api/with-cron.ts — timing-safe cron
  /\bverifyCronSecret\b/,
  /\bwithAdminAuth\b/, // lib/api/with-admin-auth.ts
  /\bverifyAdmin\b/,
  /\bverifyServiceAuth\b/, // lib/auth/verify-service-auth.ts
  /\bauth\.getUser\(/, // 手写 supabase 鉴权（存量，逐步收敛到 wrapper）
  /\bgetAuthenticatedUser\b/,
  /\bgetAuthUser\b/, // lib/supabase/server.ts
  /\bverifyAdminAuth\b/, // lib/auth/verify-service-auth.ts
  /\bCRON_SECRET\b/, // 内联 cron Bearer 校验（存量，逐步收敛到 withCron）
  /\bconstructWebhookEvent\b/, // Stripe webhook 签名验证
  /\bverifyPrivyToken\b/, // Privy Web3 auth
  /\bsignInWithPassword\b/, // 凭证自验证型端点（登录/恢复）
  /\bextractUserFromRequest\b/, // lib/auth/extract-user.ts — Bearer 用户鉴权
  /\bsafeCompare\b/, // lib/auth/verify-service-auth.ts — webhook secret 比较
  /\bisAuthorized\b/, // lib/cron/utils.ts — cron CRON_SECRET 校验
  /\bwithPublic\b/, // lib/api/middleware.ts — 显式"有意公开"wrapper（结构化决策）
]

// 显式公开端点白名单（相对 app/api 的目录路径）。
// 登记规则：只读 + 无 PII + 本来就是给未登录用户/爬虫/webhook 用的。
// 每条必须带注释说明为什么公开。
const PUBLIC_API_ROUTES = new Set([
  // —— 首次全量判定 2026-07-02（逐个人工核查 handler：全部仅 GET 或自验证/已限流）——
  // 公开市场数据（只读，产品核心是公开榜单）
  'market',
  'market/alpha',
  'market/arbitrage',
  'market/candles',
  'market/coin/[id]',
  'market/defi',
  'market/exchanges',
  'market/fear-greed',
  'market/futures',
  'market/ohlc/[id]',
  'market/overview',
  'market/realtime',
  'market/sectors',
  'market/sparklines',
  'market/spot',
  // 公开聚合统计(交易员数/交易所数,首页 hero + 跨所百分位徽章用;无用户数据,CDN 缓存 1h)
  'hero-stats',
  // 公开排行/交易员档案（只读）
  'rankings/by-token',
  'rankings/live',
  'rankings/movers',
  'rankings/platform-stats',
  'trader/[platform]/[trader_key]/history',
  'traders/[handle]/badges',
  'traders/[handle]/equity',
  'traders/[handle]/full',
  'traders/[handle]/indicators',
  'traders/[handle]/positions',
  'traders/aggregate',
  'traders/claim/status',
  'v3', // 开发者 API：内部走 API-key 鉴权 + 限流（increment_api_key_usage）
  // 公开社交读（GET only，已核）
  'feed',
  'feed/activities',
  'feed/activities/[id]',
  'groups',
  'bots',
  'bots/[id]',
  'hashtags/[tag]',
  'hashtags/trending',
  'users/[handle]/activities',
  'users/[handle]/collections',
  'users/[handle]/full',
  // OG 图/分享卡/SEO（爬虫必须匿名可达）
  'og',
  'og/compare',
  'og/exchange',
  'og/homepage',
  'og/quiz',
  'og/rank',
  'og/trader',
  'share/rank-card',
  'sitemap-xml',
  // 健康/平台状态（监控端点，设计即公开）
  'health',
  'cron/health-check',
  'platforms',
  // 实时流（公开行情推送）
  'stream/prices',
  'stream/rankings',
  'ws/market',
  // 代理类（域名/前缀白名单 + public 限流，已核 SSRF 防护）
  'avatar',
  'cdn-proxy',
  'posts/link-preview',
  // 自验证型（token/签名即凭证，无会话可言）
  'auth/siwe/nonce',
  'auth/siwe/verify',
  'email/unsubscribe',
  'attestation/[uid]',
  // 有意公开的计算端点（sensitive 限流 15/min fail-close + 30min dedup，防成本放大）
  'trader/onchain-enrich',
  // 已退役（恒 410 Gone）
  'pipeline/ingest',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name === 'route.ts' || name === 'route.tsx') out.push(p)
  }
  return out
}

const routes = walk(API_DIR)
const unauthenticated = []
for (const file of routes) {
  const src = readFileSync(file, 'utf8')
  const hasAuth = AUTH_PATTERNS.some((re) => re.test(src))
  const rel = relative(join(ROOT, 'app', 'api'), file).replace(/\/route\.tsx?$/, '')
  if (!hasAuth && !PUBLIC_API_ROUTES.has(rel)) unauthenticated.push(rel)
}

if (process.argv.includes('--list')) {
  console.log(unauthenticated.join('\n'))
  process.exit(0)
}

if (unauthenticated.length > 0) {
  console.error(
    `❌ ${unauthenticated.length}/${routes.length} 个 API route 既无 auth 原语也不在公开白名单：\n`
  )
  for (const r of unauthenticated) console.error(`  - app/api/${r}/route.ts`)
  console.error(
    '\n处理：该保护 → 加 withAuth/withCron/withAdminAuth 等 wrapper；' +
      '\n确属公开只读 → 在 scripts/qa/api-auth-coverage-check.mjs 的 PUBLIC_API_ROUTES 登记并注明理由。'
  )
  process.exit(1)
}
console.log(`✅ API 鉴权覆盖检查通过：${routes.length} 个 route 全部有 auth 原语或已登记公开。`)
