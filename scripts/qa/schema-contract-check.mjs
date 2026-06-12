/**
 * Schema 契约检查 — 代码依赖的 DB 对象必须在生产存在（自维护，零手工清单）
 *
 * 背景（2026-06 按钮审计的"根源的根源"）：仓库迁移与生产 schema 漂移
 * 反复造成全员 500（发帖/点赞/watchlist/设置页），42703/PGRST202 常被
 * safeQuery 静默吞掉数月无人发现。
 *
 * 原理：
 *   1. 运行时 grep 代码提取全部 .rpc('<name>') 与 .from('<table>') 依赖
 *   2. 调用生产 qa_schema_inventory()（service_role-only）取实际清单
 *   3. 差集即漂移 — 任何"代码在调但生产不存在"的对象立即非零退出
 *   4. 关键列清单（少量手工维护，针对曾静默失败的高危列）
 *
 * 用法:
 *   node scripts/qa/schema-contract-check.mjs
 *   建议接入: openclaw 日报 / weekly-self-check / 部署后检查
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

// ---------- 高危列契约（曾因缺失静默失败过的列） ----------
const CRITICAL_COLUMNS = {
  user_profiles: ['handle', 'referral_code', 'referred_by', 'last_export_at', 'search_history'],
  user_exchange_connections: ['last_sync_at', 'last_sync_status', 'last_sync_error'],
  posts: ['like_count', 'dislike_count', 'hot_score', 'author_handle'],
  trader_follows: ['trader_id', 'user_id'],
}

// 已知误报豁免：动态拼名 / 测试桩 / 非 public schema（说明原因再加）
// （tips / saved_filters / adjust_pro_group_member_count 的豁免已于
//   2026-06-12 移除 — 对应迁移均已应用生产。）
const RPC_IGNORE = new Set([])
const TABLE_IGNORE = new Set([
  // Storage bucket，不是表：app/api/chat/upload 用的是
  // supabase.storage.from('chat')，grep 的 .from('...') 模式误命中。
  'chat',
])

// ---------- env ----------
function readEnv(name) {
  if (process.env[name]) return process.env[name].replace(/^"|"$/g, '')
  const envFile = path.join(process.cwd(), '.env.local')
  const m = fs
    .readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`))
  if (!m) throw new Error(`${name} not found in env or .env.local`)
  return m.slice(name.length + 1).replace(/^"|"$/g, '')
}

// ---------- 1. 提取代码依赖 ----------
function extractFromCode(pattern) {
  const out = execSync(
    `grep -rhoE "${pattern}" app lib worker --include='*.ts' --include='*.tsx' 2>/dev/null | sort -u`,
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
  return out
    .split('\n')
    .map((l) => {
      const m = l.match(/'([a-z0-9_]+)'/)
      return m ? m[1] : null
    })
    .filter(Boolean)
}

const codeRpcs = [...new Set(extractFromCode("\\.rpc\\('[a-z0-9_]+'"))].filter(
  (r) => !RPC_IGNORE.has(r)
)
const codeTables = [...new Set(extractFromCode("\\.from\\('[a-z0-9_]+'"))].filter(
  (t) => !TABLE_IGNORE.has(t)
)

// ---------- 2. 生产清单 ----------
const URL_ = readEnv('NEXT_PUBLIC_SUPABASE_URL')
const KEY = readEnv('SUPABASE_SERVICE_ROLE_KEY')

const res = await fetch(`${URL_}/rest/v1/rpc/qa_schema_inventory`, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
})
if (!res.ok) {
  console.error(`❌ qa_schema_inventory 调用失败 (${res.status}) — 该 RPC 本身是契约的一部分`)
  console.error('   迁移: supabase/migrations/20260612142910_qa_schema_inventory_rpc.sql')
  process.exit(1)
}
const inv = await res.json()
const prodFunctions = new Set(inv.functions || [])
const prodTables = new Set(inv.tables || [])
const prodColumns = inv.columns || {}

// ---------- 3. 差集 ----------
const failures = []
for (const rpc of codeRpcs) {
  if (!prodFunctions.has(rpc)) failures.push(`RPC 缺失: ${rpc}（代码在调用）`)
}
for (const t of codeTables) {
  // .from() 也可能是视图 — inventory 的 tables 含视图（information_schema.tables）
  if (!prodTables.has(t)) failures.push(`表/视图缺失: ${t}（代码在查询）`)
}
for (const [t, cols] of Object.entries(CRITICAL_COLUMNS)) {
  const have = new Set(prodColumns[t] || [])
  for (const c of cols) {
    if (!have.has(c)) failures.push(`关键列缺失: ${t}.${c}`)
  }
}

// ---------- 4. 结果 ----------
console.log(
  `检查范围: 代码 ${codeRpcs.length} RPC + ${codeTables.length} 表 vs 生产 ${prodFunctions.size} 函数 + ${prodTables.size} 表`
)
if (failures.length) {
  console.error(`\n❌ Schema 契约失败 (${failures.length}):`)
  for (const f of failures) console.error(`   ${f}`)
  console.error('\n→ 大概率是仓库迁移未应用到生产；确属误报则加入脚本顶部豁免清单（注明原因）。')
  process.exit(1)
}
console.log('✅ Schema 契约通过 — 代码依赖的对象在生产全部存在')
