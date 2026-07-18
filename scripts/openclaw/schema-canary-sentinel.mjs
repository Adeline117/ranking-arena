/**
 * Schema 契约 + 写路径金丝雀哨兵（每日跑，失败 Telegram 告警）
 *
 * 背景（2026-06 按钮审计）：~200 个迁移未应用生产导致发帖/点赞/订阅
 * 长期静默 500 无人发现。此哨兵让该类问题的发现成本 = 0 人力 / 24h 内。
 *
 * 检查项:
 *   1. schema 契约 — node scripts/qa/schema-contract-check.mjs
 *      （代码 .rpc()/.from() 依赖 vs 生产实际清单，差集即漂移）
 *   2. 写路径金丝雀 — QA 账号（qa.button.test@arenafi.org）完整做一轮
 *      发帖 → 点赞 → 评论 → 删帖（全部清理，零数据残留）
 *
 * 用法（crontab，环境变量同 health-monitor）:
 *   node scripts/openclaw/schema-canary-sentinel.mjs
 *
 * QA 账号密码: 持久化（env QA_TEST_PASSWORD / ~/.arena-qa-password.json），
 * 经 scripts/qa/qa-auth.mjs 单一通道登录 — 绝不无脑重置（重置吊销全部既存
 * session，会杀死并发 QA sweep 的登录态）。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { loginQa } from '../qa/qa-auth.mjs'

const BASE = 'https://www.arenafi.org'

// cron 场景铁律：任何网络请求必须有超时，否则挂起连接 = 僵尸 cron 堆积
// （2026-06-12 实测：无超时版本在系统高负载时永久挂起）
const FETCH_TIMEOUT_MS = 30_000
const tfetch = (url, init = {}) =>
  fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

function readEnv(name, { optional = false } = {}) {
  if (process.env[name]) return process.env[name].replace(/^"|"$/g, '')
  for (const file of ['.env.local', '.env']) {
    try {
      const m = fs
        .readFileSync(path.join(process.cwd(), file), 'utf8')
        .split('\n')
        .find((l) => l.startsWith(`${name}=`))
      if (m) return m.slice(name.length + 1).replace(/^"|"$/g, '')
    } catch {
      /* file missing */
    }
  }
  if (optional) return null
  throw new Error(`${name} not found`)
}

const TELEGRAM_BOT_TOKEN = readEnv('TELEGRAM_BOT_TOKEN', { optional: true })
const TELEGRAM_CHAT_ID = readEnv('TELEGRAM_ALERT_CHAT_ID', { optional: true })

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[telegram skipped]', text)
    return
  }
  await tfetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.error('telegram send failed:', e.message))
}

const failures = []

// ---------- 1. Schema 契约 ----------
try {
  const out = execSync('node scripts/qa/schema-contract-check.mjs', {
    encoding: 'utf8',
    timeout: 120_000,
  })
  console.log(out.trim())
} catch (e) {
  failures.push(`Schema 契约失败:\n${(e.stdout || '') + (e.stderr || '')}`.slice(0, 800))
}

// ---------- 1b. 填充率契约(该有 vs 真有) ----------
// active+serving registry 为每个来源/窗口声明的 expected_metrics，必须在最新
// 通过数量门的榜单人群中有新鲜 trader_stats(0 填充 = parser/管道断裂)。
// 本地无凭据可跳过；定时工作流设置 REQUIRE_DATABASE_URL=1。只要配置了数据库，
// 合同、查询或证据写入失败都硬红，不能把监控失明当成健康。
try {
  const out = execSync('node scripts/qa/fill-rate-check.mjs', {
    encoding: 'utf8',
    timeout: 120_000,
    // 本地 crontab 跑时 process.env 无 DATABASE_URL — readEnv 会兜到 .env.local
    env: { ...process.env, DATABASE_URL: readEnv('DATABASE_URL', { optional: true }) ?? '' },
  })
  console.log(out.trim())
} catch (e) {
  failures.push(`填充率契约失败:\n${(e.stdout || '') + (e.stderr || '')}`.slice(0, 800))
}

// ---------- 1c. 渲染覆盖契约(库里有 vs 页面拿得到) ----------
// 黄金交易员的 DB 非空指标必须出现在生产 /core API 响应里(serving/映射层
// 丢数据 = bybit sortino 断链一类)。基建失败(网络/5xx)脚本内部自行降级。
try {
  const out = execSync('node scripts/qa/render-coverage-check.mjs', {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, DATABASE_URL: readEnv('DATABASE_URL', { optional: true }) ?? '' },
  })
  console.log(out.trim())
} catch (e) {
  failures.push(`渲染覆盖契约失败:\n${(e.stdout || '') + (e.stderr || '')}`.slice(0, 800))
}

// ---------- 1d. 上游新字段雷达(信息级,不判红) ----------
// ingest 采样收集的 raw payload 字段清单里,过去 24h 首次出现的 field_path
// = 交易所悄悄新增的字段 → Telegram 摘要提示评估是否采集(P1)。
// 纯信息:不进 failures;查询失败也只打日志。
try {
  const { default: pg } = await import('pg')
  const dbUrl = readEnv('DATABASE_URL', { optional: true })
  if (dbUrl) {
    const pool = new pg.Pool({ connectionString: dbUrl, max: 1 })
    try {
      const { rows } = await pool.query(
        `select s.slug, i.job_type, i.field_path
           from arena.upstream_field_inventory i
           join arena.sources s on s.id = i.source_id
          where i.first_seen >= now() - interval '1 day'
            -- 建库首日全量 first_seen 会爆炸:清单本身 3 天内的源全跳过
            and exists (
              select 1 from arena.upstream_field_inventory b
               where b.source_id = i.source_id and b.first_seen < now() - interval '3 days')
          order by s.slug, i.field_path limit 60`
      )
      if (rows.length > 0) {
        const lines = rows.map((r) => `  ${r.slug}/${r.job_type}: ${r.field_path}`)
        await sendTelegram(
          `📡 上游新字段雷达: ${rows.length} 个新 field_path(评估是否采集,结论记 UNREACHABLE_FIELDS_LEDGER)\n` +
            lines.slice(0, 30).join('\n') +
            (rows.length > 30 ? `\n  … +${rows.length - 30}` : '')
        )
        console.log(`📡 新字段 ${rows.length} 个,已发 Telegram 摘要`)
      } else {
        console.log('📡 上游新字段雷达: 无新字段')
      }
    } finally {
      await pool.end()
    }
  }
} catch (e) {
  console.error('upstream-field radar failed (not a violation):', e.message)
}

// ---------- 2. 写路径金丝雀 ----------
async function writeCanary() {
  const SUPA_URL = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const SRK = readEnv('SUPABASE_SERVICE_ROLE_KEY')
  const ANON = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')

  // 2026-07-01 根治：不再每次运行重置密码（重置吊销 QA 账号全部既存 session，
  // 会杀死并发 sweep 正在使用的登录态）。走 qa-auth 单一通道：持久化密码
  // password-grant 优先，登录失败才在 /tmp 互斥锁内 fallback 重置（串行化）。
  const session = await loginQa({ supaUrl: SUPA_URL, anon: ANON, srk: SRK })

  // CSRF（proxy.ts 格式：base36 时间戳.64hex）
  const csrf = `${Date.now().toString(36)}.${crypto.randomBytes(32).toString('hex')}`
  const H = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
    'x-csrf-token': csrf,
    Cookie: `csrf-token=${csrf}`,
    // WAF 会拦 Node 默认 UA（Forbidden）— 伪装浏览器 UA
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ArenaSentinel',
  }
  const api = async (pathname, init = {}) => {
    const res = await tfetch(`${BASE}${pathname}`, { ...init, headers: { ...H, ...init.headers } })
    let body = null
    try {
      body = await res.json()
    } catch {
      /* non-json */
    }
    return { status: res.status, body }
  }

  // 删帖 + GET 回查确认真的删掉了。教训（2026-07-02）：deletePost 曾对
  // 0 行匹配静默 no-op 仍返回 200，且进程中途被杀时 finally 不执行 →
  // 3 条 canary 帖公开残留在生产帖子流最新位置多日无人发现。
  const deleteAndVerify = async (id) => {
    const del = await api(`/api/posts/${id}`, { method: 'DELETE' })
    if (del.status >= 400) throw new Error(`删帖失败 ${del.status} (post ${id} 可能残留!)`)
    const check = await api(`/api/posts/${id}`)
    if (check.status !== 404)
      throw new Error(`删帖后回查非 404 (GET ${check.status}) — post ${id} 残留在生产!`)
  }

  // 自愈：清扫历史残留 canary 帖（上次运行进程被杀 / 删除失败告警被忽略的残留），
  // 不依赖人工发现。按 QA 账号 author_id + canary 标题精确匹配，绝不误伤真实用户帖。
  const qaUserId = JSON.parse(
    Buffer.from(session.access_token.split('.')[1], 'base64url').toString()
  ).sub
  const CANARY_TITLE = 'canary — auto-deleted'
  try {
    const res = await tfetch(
      `${SUPA_URL}/rest/v1/posts?author_id=eq.${qaUserId}&title=eq.${encodeURIComponent(CANARY_TITLE)}&select=id`,
      { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } }
    )
    const leftovers = res.ok ? await res.json() : []
    for (const p of Array.isArray(leftovers) ? leftovers : []) {
      await deleteAndVerify(p.id)
      console.log(`🧹 已清扫上次残留 canary 帖: ${p.id}`)
    }
  } catch (e) {
    failures.push(`残留 canary 帖清扫失败: ${e.message}`)
  }

  // 发帖
  const create = await api('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      title: CANARY_TITLE,
      content: '[sentinel] daily write-path canary. Auto-cleaned.',
    }),
  })
  const postId = create.body?.data?.post?.id || create.body?.data?.id
  if (!postId)
    throw new Error(`发帖失败 ${create.status}: ${JSON.stringify(create.body).slice(0, 150)}`)

  try {
    // 点赞 + 取消
    const like = await api(`/api/posts/${postId}/like`, {
      method: 'POST',
      body: JSON.stringify({ reaction_type: 'up' }),
    })
    if (like.status >= 400) throw new Error(`点赞失败 ${like.status}`)
    await api(`/api/posts/${postId}/like`, {
      method: 'POST',
      body: JSON.stringify({ reaction_type: 'up' }),
    })

    // 评论 + 删评论
    const comment = await api(`/api/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: '[sentinel] canary comment' }),
    })
    const commentId = comment.body?.data?.comment?.id || comment.body?.data?.id
    if (!commentId) throw new Error(`评论失败 ${comment.status}`)
    const delC = await api(`/api/posts/${postId}/comments`, {
      method: 'DELETE',
      body: JSON.stringify({ comment_id: commentId }),
    })
    if (delC.status >= 400) throw new Error(`删评论失败 ${delC.status}`)
  } finally {
    // 删帖（无论中途失败与否都清理）+ GET 回查确认 404。
    // 用 failures.push 而非 throw：finally 里 throw 会吞掉 try 块的原始错误。
    try {
      await deleteAndVerify(postId)
    } catch (e) {
      failures.push(`金丝雀删帖清理失败: ${e.message}`)
    }
  }
  console.log('✅ 写路径金丝雀通过: 发帖→点赞→评论→删除 全 2xx，零残留')
}

try {
  await writeCanary()
} catch (e) {
  failures.push(`写路径金丝雀失败: ${e.message}`)
}

// ---------- 结果 ----------
if (failures.length) {
  const msg = `🚨 Arena 哨兵告警 (${new Date().toISOString().slice(0, 10)})\n\n${failures.join('\n\n')}`
  console.error(msg)
  await sendTelegram(msg)
  process.exit(1)
}
console.log('✅ 哨兵全绿: schema 契约 + 写路径金丝雀')
process.exit(0)
