/**
 * 迁移落地核对（P1 · ADVISORY）—— surfacing 未应用迁移的候选
 *
 * ⚠️ ADVISORY-ONLY,不可作阻断门。原因(2026-06-13 实测确认):
 *   本项目迁移经 MCP/SQL-editor 用 *任意名字* 应用,仓库文件名↔ledger 名字
 *   没有可靠对应。按 name 匹配会对"换名应用"的迁移误报 —— 例如仓库
 *   `score_inputs_align_compat.sql` 内容已应用,但 ledger 名字是
 *   `arena_score_inputs_json`,本检查会误判为"未应用"。
 *   → 稳健的漂移主门是 `qa:schema`(schema-contract-check):它查 *现实*
 *     (列/表/函数在生产存不存在),不查 *出身*(文件应用没有),不受
 *     应用通道影响。本检查只作 *候选 surfacing*,每条需人工确认。
 *   → 根治:P3 编排纪律 —— schema 变更走单一通道(supabase db push,
 *     ledger.name = 文件描述),name 匹配才可靠。届时本检查可升为阻断门。
 *
 * 核对:仓库 baseline(20260611) 后的迁移文件,名字(去时间戳前缀)是否在
 * 生产 ledger 的 name 集合。缺失 = *候选* 未应用(可能是真漂移,也可能是
 * 换名应用的误报)。baseline 前的 ~200 历史迁移多已弃用/superseded,不核对。
 *
 * 用法:
 *   node scripts/qa/check-migration-ledger.mjs
 *   ci.yml: 始终 continue-on-error(advisory,只报告候选,绝不阻断)。
 */
import fs from 'node:fs'
import path from 'node:path'

const BASELINE = '20260611000000' // ledger 可靠追踪起点之前不核对
const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations')

function readEnv(name) {
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
  throw new Error(`${name} not found in env or .env.local`)
}

// 1. 仓库 baseline 之后的迁移 → 名字集合
const repoNames = []
for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
  if (!f.endsWith('.sql')) continue
  const m = f.match(/^(\d{14})_(.+)\.sql$/) // 纯时间戳命名(字母后缀历史文件被 baseline 滤掉)
  if (!m) continue
  const [, version, name] = m
  if (version < BASELINE) continue
  repoNames.push({ file: f, version, name })
}

// 2. 生产 ledger 名字集合
const URL_ = readEnv('NEXT_PUBLIC_SUPABASE_URL')
const KEY = readEnv('SUPABASE_SERVICE_ROLE_KEY')
const res = await fetch(`${URL_}/rest/v1/rpc/qa_schema_inventory`, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
})
if (!res.ok) {
  console.error(`❌ qa_schema_inventory 调用失败 (${res.status}) —— RPC 本身是契约的一部分`)
  console.error('   迁移: supabase/migrations/20260613100000_qa_inventory_add_ledger.sql')
  process.exit(1)
}
const inv = await res.json()
const ledger = new Set(inv.migration_names || [])

// 3. 差集：仓库有、ledger 无 = 未应用
const missing = repoNames.filter((m) => !ledger.has(m.name))

console.log(
  `检查范围(ADVISORY): 仓库 baseline(${BASELINE}) 后 ${repoNames.length} 个迁移 vs ledger ${ledger.size} 个已应用`
)
if (missing.length) {
  console.error(`\n⚠️  候选未应用迁移 (${missing.length}) —— 需人工确认(可能是换名应用的误报):`)
  for (const m of missing) console.error(`   ${m.file}  (name: ${m.name})`)
  console.error('\n→ 逐条确认:其 schema 效果是否已在生产(可能经别的 ledger 名字应用)。')
  console.error('   真未应用 → 用 supabase db push 应用;换名应用的误报 → 忽略。')
  console.error('   稳健的漂移主门是 `npm run qa:schema`(查现实而非出身)。')
  process.exit(1)
}
console.log('✅ baseline 后仓库迁移名字全部在 ledger 命中')
