#!/usr/bin/env node
/**
 * Arena Pipeline 健康检查脚本
 *
 * 功能：
 * 1. 检查所有 fetcher 的错误处理模式
 * 2. 检查数据新鲜度
 * 3. 检查 API 可达性
 * 4. 生成修复建议
 *
 * 用法：
 *   node scripts/pipeline-health-check.mjs           # 完整检查
 *   node scripts/pipeline-health-check.mjs --quick   # 快速检查（仅数据新鲜度）
 *   node scripts/pipeline-health-check.mjs --fix     # 生成修复脚本
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { dirname, join, basename } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(__dirname, '..')

// Load env
function loadEnv() {
  const envPath = join(ROOT_DIR, '.env.local')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2]
      }
    }
  } catch (e) {}
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// ============================================
// 检查结果类型
// ============================================

const results = {
  errorHandling: [],
  dataFreshness: [],
  apiReachability: [],
  suggestions: [],
}

// ============================================
// 1. 检查 Fetcher 错误处理模式
// ============================================

const REQUIRED_PATTERNS = [
  { name: 'try-catch', pattern: /try\s*\{[\s\S]*catch\s*\(/, required: true },
  {
    name: 'Sentry/logger',
    pattern: /captureMessage|captureException|logger\.(error|warn)/,
    required: true,
  },
  { name: 'rate limiting', pattern: /sleep|delay|setTimeout|rateLim/, required: false },
  // fetchJsonWithRetry / fetchWithFallback / fetchWithVpsFallback from shared.ts provide retry
  {
    name: 'retry logic',
    pattern:
      /retry|attempt|maxRetries|fetchJsonWithRetry|fetchWithFallback|fetchWithVpsFallback|withRetry/,
    required: false,
  },
  // config-driven-fetcher and batch-fetch-traders provide circuit breaker at infrastructure level
  {
    name: 'circuit breaker',
    pattern: /circuitBreaker|failureCount|isOpen|createConfigDrivenFetcher|getInlineFetcher/,
    required: false,
  },
]

function checkFetcherErrorHandling() {
  console.log('\n=== 1. Fetcher 错误处理检查 ===\n')

  const fetcherDir = join(ROOT_DIR, 'lib/cron/fetchers')
  // 2026-07-03: legacy lib/cron/fetchers was removed — ingest adapters
  // (lib/ingest/adapters/) with built-in retry/circuit-breaker replaced it.
  // Without this guard the whole health check crashed at section 1 (ENOENT),
  // never reaching the freshness sections that still matter.
  if (!existsSync(fetcherDir)) {
    console.log('⏭️  lib/cron/fetchers 已删除(由 lib/ingest/adapters 取代)— 跳过本节')
    return { passCount: 0, warnCount: 0, failCount: 0 }
  }
  // Skip non-fetcher utility files (DB ops, math calculations, type definitions, config helpers)
  // Skip utility files: DB ops, math, types, configs, enrichment sub-modules (called by enrichment-runner.ts with withRetry)
  // Skip ALL enrichment-*.ts sub-modules — they are called by enrichment-runner.ts with withRetry/circuit breaker
  const SKIP_FILES = new Set([
    'index.ts',
    'shared.ts',
    'enrichment.ts',
    'enrichment-types.ts',
    'enrichment-db.ts',
    'enrichment-metrics.ts',
    'enrichment-binance.ts',
    'enrichment-binance-spot.ts',
    'enrichment-bybit.ts',
    'enrichment-bitget.ts',
    'enrichment-bitfinex.ts',
    'enrichment-bingx.ts',
    'enrichment-blofin.ts',
    'enrichment-dex.ts',
    'enrichment-htx.ts',
    'enrichment-okx.ts',
    'enrichment-bitunix.ts',
    'enrichment-btcc.ts',
    'enrichment-coinex.ts',
    'enrichment-copin.ts',
    'enrichment-drift.ts',
    'enrichment-dydx.ts',
    'enrichment-etoro.ts',
    'enrichment-gateio.ts',
    'enrichment-jupiter.ts',
    'enrichment-mexc.ts',
    'enrichment-onchain.ts',
    'enrichment-phemex.ts',
    'enrichment-toobit.ts',
    'enrichment-wallet.ts',
    'enrichment-xt.ts',
    'exchange-configs.ts',
    'scraper-config.ts',
    'verify-registry.ts',
    'vertex.ts',
  ])
  const files = readdirSync(fetcherDir).filter((f) => f.endsWith('.ts') && !SKIP_FILES.has(f))

  // Read index.ts to check which fetchers are registered (and thus get retry wrapper)
  const indexContent = readFileSync(join(fetcherDir, 'index.ts'), 'utf-8')
  const hasInfraRetry = /getInlineFetcher[\s\S]*maxRetries|retry/.test(indexContent)

  let passCount = 0
  let warnCount = 0
  let failCount = 0

  for (const file of files) {
    const filePath = join(fetcherDir, file)
    const content = readFileSync(filePath, 'utf-8')
    const platform = basename(file, '.ts')

    // Check if this fetcher is registered in INLINE_FETCHERS (gets infrastructure-level retry)
    const exportedFnMatch = content.match(/export\s+(?:async\s+)?function\s+(\w+)/)
    const fnName = exportedFnMatch ? exportedFnMatch[1] : ''
    const isRegistered = hasInfraRetry && indexContent.includes(fnName)

    const checks = []
    for (const pattern of REQUIRED_PATTERNS) {
      let hasPattern = pattern.pattern.test(content)
      // If registered in index.ts with retry wrapper, count retry+circuit breaker as present
      if (isRegistered && (pattern.name === 'retry logic' || pattern.name === 'circuit breaker')) {
        hasPattern = true
      }
      checks.push({ ...pattern, found: hasPattern })
    }

    const requiredMissing = checks.filter((c) => c.required && !c.found)
    const optionalMissing = checks.filter((c) => !c.required && !c.found)

    let status = 'PASS'
    if (requiredMissing.length > 0) {
      status = 'FAIL'
      failCount++
    } else if (optionalMissing.length >= 2) {
      status = 'WARN'
      warnCount++
    } else {
      passCount++
    }

    const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : '❌'
    console.log(`${icon} ${platform.padEnd(20)} ${status}`)

    if (status !== 'PASS') {
      const missing = [...requiredMissing, ...optionalMissing].map((c) => c.name).join(', ')
      console.log(`   Missing: ${missing}`)
      results.errorHandling.push({ platform, status, missing })
    }
  }

  console.log(`\n总计: ${passCount} 通过, ${warnCount} 警告, ${failCount} 失败`)
  return { passCount, warnCount, failCount }
}

// ============================================
// 2. 检查数据新鲜度
// ============================================

async function checkDataFreshness() {
  console.log('\n=== 2. 数据新鲜度检查 ===\n')

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('跳过：未配置 Supabase 环境变量')
    return
  }

  const STALE_HOURS = 8
  const CRITICAL_HOURS = 24

  try {
    // Get latest snapshot for each platform
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_platform_freshness`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    if (!res.ok) {
      throw new Error(`active source freshness RPC returned HTTP ${res.status}`)
    }

    const rpcData = await res.json()
    if (!Array.isArray(rpcData) || rpcData.length === 0) {
      throw new Error('active source freshness RPC returned no rows')
    }

    const now = Date.now()
    const seenPlatforms = new Set()
    let freshCount = 0
    let staleCount = 0
    let criticalCount = 0

    for (const row of rpcData) {
      const platform = String(row.source ?? row.platform ?? '').trim()
      if (!platform || seenPlatforms.has(platform)) {
        throw new Error(`active source freshness RPC returned an invalid source: ${platform}`)
      }
      seenPlatforms.add(platform)

      const latest = row.latest ?? row.latest_snapshot ?? null
      const timestamp = latest == null ? null : new Date(latest).getTime()
      if (
        (timestamp != null && !Number.isFinite(timestamp)) ||
        (timestamp != null && timestamp > now + 5 * 60 * 1000)
      ) {
        throw new Error(`active source freshness RPC returned an invalid timestamp: ${platform}`)
      }

      const ageHours = timestamp == null ? null : (now - timestamp) / (1000 * 60 * 60)
      let status = 'FRESH'
      let icon = '🟢'

      if (ageHours == null || ageHours >= CRITICAL_HOURS) {
        status = 'CRITICAL'
        icon = '🔴'
        criticalCount++
        results.dataFreshness.push({
          platform,
          status,
          ageHours: ageHours == null ? null : Math.round(ageHours),
        })
      } else if (ageHours >= STALE_HOURS) {
        status = 'STALE'
        icon = '🟡'
        staleCount++
        results.dataFreshness.push({
          platform,
          status,
          ageHours: Math.round(ageHours),
        })
      } else {
        freshCount++
      }

      const ageLabel = ageHours == null ? 'never fetched' : `${Math.round(ageHours)}h ago`
      console.log(`${icon} ${platform.padEnd(24)} ${ageLabel}`)
    }

    console.log(`\n总计: ${freshCount} 新鲜, ${staleCount} 陈旧, ${criticalCount} 严重`)
    return { freshCount, staleCount, criticalCount }
  } catch (err) {
    console.error('检查失败:', err.message)
    throw err
  }
}

// ============================================
// 2b. bot_snapshots 新鲜度哨兵（/rankings/bots）
// ============================================
//
// 背景（2026-07-02 审计）：bot_snapshots 全仓库只有读取方（app/api/bots/*），
// 没有任何写入方/cron —— 数据 2026-02-11 一次性灌入后再未刷新，页面停更近
// 5 个月无人发现。此哨兵让停更可见，防止再次静默腐烂。
//
// 注意：报 🟡 WARN + 建议，不翻 exit code —— 没有可修的 fetcher（重建采集
// 应走 worker/ingest 通道 vs 下线页面，待产品决策），恒 CRITICAL 会让脚本
// 永远 exit(1)、掩盖其他新增严重问题。决策落地后再收紧为 CRITICAL。

async function checkBotSnapshotsFreshness() {
  console.log('\n=== 2b. bot_snapshots 新鲜度哨兵 (/rankings/bots) ===\n')

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('跳过：未配置 Supabase 环境变量')
    return
  }

  const STALE_DAYS = 7

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bot_snapshots?select=captured_at&order=captured_at.desc&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    )

    if (!res.ok) {
      console.log(`⚠️  bot_snapshots 查询失败 (HTTP ${res.status}) — 表可能不存在或权限问题`)
      return
    }

    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log('⚪ bot_snapshots 无数据（页面应展示空态）')
      return
    }

    const ageDays = Math.floor(
      (Date.now() - new Date(rows[0].captured_at).getTime()) / (1000 * 60 * 60 * 24)
    )

    if (ageDays >= STALE_DAYS) {
      console.log(`🟡 bot_snapshots 停更 ${ageDays} 天（最新 captured_at: ${rows[0].captured_at}）`)
      console.log('   /rankings/bots 正在展示过期快照（页面已有 stale 警示横幅兜底）')
      results.dataFreshness.push({
        platform: 'bot_snapshots',
        status: 'STALE',
        ageHours: ageDays * 24,
      })
      results.suggestions.push({
        platform: 'bot_snapshots',
        priority: 'MEDIUM',
        action: `/rankings/bots 数据停更 ${ageDays} 天 — 无写入方。待产品决策：重建采集（走 worker/ingest 通道，勿新增 Vercel cron）或下线该页`,
        command: '# 产品决策后执行：重建 bot_snapshots 采集 job 或下线 /rankings/bots',
      })
    } else {
      console.log(`🟢 bot_snapshots 新鲜（${ageDays} 天前）`)
    }
  } catch (err) {
    console.error('bot_snapshots 哨兵检查失败:', err.message)
  }
}

// ============================================
// 3. 生成修复建议
// ============================================

function generateSuggestions() {
  console.log('\n=== 3. 修复建议 ===\n')

  // Error handling suggestions
  for (const item of results.errorHandling) {
    if (item.status === 'FAIL') {
      results.suggestions.push({
        platform: item.platform,
        priority: 'HIGH',
        action: `添加 try-catch 和 Sentry 日志到 ${item.platform}.ts`,
        command: `claude -p "在 lib/cron/fetchers/${item.platform}.ts 中添加标准错误处理模板"`,
      })
    }
  }

  // Data freshness suggestions
  for (const item of results.dataFreshness) {
    if (item.status === 'CRITICAL') {
      const outageDuration = Number.isFinite(item.ageHours) ? `${item.ageHours}h` : '从未成功'
      results.suggestions.push({
        platform: item.platform,
        priority: 'HIGH',
        action: `修复 ${item.platform} 数据抓取（${outageDuration}）`,
        command: `/fix-pipeline ${item.platform}`,
      })
    }
  }

  // Print suggestions
  if (results.suggestions.length === 0) {
    console.log('🎉 无需修复！所有 pipeline 状态正常。')
  } else {
    console.log(`发现 ${results.suggestions.length} 个待修复项：\n`)

    const highPriority = results.suggestions.filter((s) => s.priority === 'HIGH')
    const medPriority = results.suggestions.filter((s) => s.priority === 'MEDIUM')

    if (highPriority.length > 0) {
      console.log('🔴 高优先级:')
      for (const s of highPriority) {
        console.log(`   - ${s.platform}: ${s.action}`)
        console.log(`     运行: ${s.command}`)
      }
    }

    if (medPriority.length > 0) {
      console.log('\n🟡 中优先级:')
      for (const s of medPriority) {
        console.log(`   - ${s.platform}: ${s.action}`)
      }
    }
  }

  return results.suggestions
}

// ============================================
// 4. 生成自动修复脚本
// ============================================

function generateFixScript() {
  console.log('\n=== 4. 自动修复脚本 ===\n')

  if (results.suggestions.length === 0) {
    console.log('无需生成修复脚本。')
    return
  }

  const script = `#!/bin/bash
# Arena Pipeline 自动修复脚本
# 生成时间: ${new Date().toISOString()}

set -e

${results.suggestions
  .map(
    (s) => `
# 修复 ${s.platform}
echo "修复 ${s.platform}..."
${s.command}
`
  )
  .join('\n')}

echo "修复完成！"
`

  console.log('修复脚本已生成:\n')
  console.log(script)
}

// ============================================
// Main
// ============================================

async function main() {
  const args = process.argv.slice(2)
  const quickMode = args.includes('--quick')
  const fixMode = args.includes('--fix')

  console.log('╔══════════════════════════════════════════╗')
  console.log('║     Arena Pipeline 健康检查              ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`模式: ${quickMode ? '快速' : fixMode ? '修复' : '完整'}`)

  if (!quickMode) {
    checkFetcherErrorHandling()
  }

  await checkDataFreshness()

  await checkBotSnapshotsFreshness()

  generateSuggestions()

  if (fixMode) {
    generateFixScript()
  }

  // 返回退出码
  const criticalCount = results.dataFreshness.filter((d) => d.status === 'CRITICAL').length
  const failCount = results.errorHandling.filter((e) => e.status === 'FAIL').length

  if (criticalCount > 0 || failCount > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('健康检查失败:', err)
  process.exit(1)
})
