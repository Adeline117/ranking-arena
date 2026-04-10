#!/usr/bin/env node
/**
 * OpenClaw Auto-Fix — Diagnoses and fixes failing fetchers automatically
 *
 * Usage:
 *   node scripts/openclaw/auto-fix.mjs <platform> [--reason <failure_reason>]
 *   node scripts/openclaw/auto-fix.mjs bybit --reason waf_blocked
 *   node scripts/openclaw/auto-fix.mjs --check-all  (check all platforms, fix any failing)
 *
 * Environment:
 *   ARENA_DIR         - Path to arena repo (default: current dir)
 *   TELEGRAM_BOT_TOKEN - For sending fix reports
 *   TELEGRAM_CHAT_ID  - Chat to send reports to
 *   ARENA_API_URL     - Arena API base URL (default: https://www.arenafi.org)
 *   CRON_SECRET       - For authenticating to health API
 *   AUTO_FIX_ENABLED  - Set to 'true' to actually run fixes (default: dry-run)
 */

import { execSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
const __fixdir = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__fixdir, '../../.env') })

const ARENA_DIR = process.env.ARENA_DIR || process.cwd()
// OPENCLAW_WORKTREE: dedicated git worktree for autonomous Claude fix sessions.
// Defaults to ~/arena-openclaw on branch openclaw/auto-fix. Running fixes in
// a separate worktree keeps autonomous commits OFF main until a human merges
// them, avoiding N-way push races with interactive sessions.
// Falls back to ARENA_DIR if the worktree doesn't exist (opt-in upgrade).
const OPENCLAW_WORKTREE = process.env.OPENCLAW_WORKTREE || path.resolve(process.env.HOME || '', 'arena-openclaw')
const FIX_CWD = fs.existsSync(OPENCLAW_WORKTREE) ? OPENCLAW_WORKTREE : ARENA_DIR
const API_URL = process.env.ARENA_API_URL || 'https://www.arenafi.org'
const CRON_SECRET = process.env.CRON_SECRET || ''
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID || ''
const AUTO_FIX_ENABLED = process.env.AUTO_FIX_ENABLED === 'true'

// Maximum time for a fix attempt (5 minutes)
const FIX_TIMEOUT_MS = 5 * 60 * 1000

// ============================================
// Telegram Helper
// ============================================

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
    console.log('[自动修复] Telegram 未配置，仅写日志:', message)
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text: message,
        parse_mode: 'HTML',
      }),
    })
  } catch (err) {
    console.error('[自动修复] Telegram 发送失败:', err.message)
  }
}

// ============================================
// Diagnosis
// ============================================

async function fetchPipelineHealth() {
  const res = await fetch(`${API_URL}/api/health/pipeline`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })
  if (!res.ok) throw new Error(`Health API returned ${res.status}`)
  return res.json()
}

async function getFailingPlatforms() {
  const health = await fetchPipelineHealth()
  const failing = []

  // Check job statuses
  for (const job of health.jobs || []) {
    if (job.health_status === 'failed' || job.health_status === 'stuck') {
      // Extract platform name from job_name (e.g., "fetch-traders-bybit" -> "bybit")
      const match = job.job_name?.match(/fetch-traders-(.+)/)
      if (match) {
        failing.push({
          platform: match[1],
          status: job.health_status,
          lastError: job.error_message,
          lastRun: job.started_at,
        })
      }
    }
  }

  // Also check stats for low success rates
  for (const stat of health.stats || []) {
    const match = stat.job_name?.match(/fetch-traders-(.+)/)
    if (match && stat.success_rate < 50) {
      const existing = failing.find((f) => f.platform === match[1])
      if (!existing) {
        failing.push({
          platform: match[1],
          status: 'degraded',
          successRate: stat.success_rate,
          lastRun: stat.last_run,
        })
      }
    }
  }

  return failing
}

function diagnosePlatform(platform, reason) {
  // Read the fetcher file to understand current implementation
  const fetcherPath = path.join(ARENA_DIR, 'lib/cron/fetchers', `${platform.replace(/_/g, '-')}.ts`)

  if (!fs.existsSync(fetcherPath)) {
    return {
      fetcherPath: null,
      diagnosis: `Fetcher file not found: ${fetcherPath}`,
      fix策略: 'manual',
    }
  }

  const content = fs.readFileSync(fetcherPath, 'utf-8')

  // Classify the fix strategy based on failure reason
  const strategies = {
    'geo_blocked': {
      strategy: 'proxy_fallback',
      description: 'Add or fix VPS proxy fallback for geo-blocked API',
      risk: 'low',
      autoFixable: true,
    },
    'waf_blocked': {
      strategy: 'headers_or_proxy',
      description: 'Update headers, add CF worker proxy, or add stealth browser fallback',
      risk: 'low',
      autoFixable: true,
    },
    'endpoint_gone': {
      strategy: 'api_discovery',
      description: 'Exchange API endpoint changed — need to find new endpoint',
      risk: 'medium',
      autoFixable: true,
    },
    'rate_limited': {
      strategy: 'backoff',
      description: 'Add exponential backoff or reduce request frequency',
      risk: 'low',
      autoFixable: true,
    },
    'auth_required': {
      strategy: 'manual',
      description: 'API now requires authentication — needs human review',
      risk: 'high',
      autoFixable: false,
    },
    'parse_error': {
      strategy: 'response_update',
      description: 'API response format changed — update parser',
      risk: 'medium',
      autoFixable: true,
    },
    'timeout': {
      strategy: 'timeout_increase',
      description: 'Increase timeout or add retry logic',
      risk: 'low',
      autoFixable: true,
    },
  }

  const strategyInfo = strategies[reason] || {
    strategy: 'investigate',
    description: 'Unknown failure — needs investigation',
    risk: 'medium',
    autoFixable: true,
  }

  return {
    fetcherPath,
    fetcherExists: true,
    hasProxyFallback: content.includes('fetchWithFallback') || content.includes('VPS_PROXY'),
    hasRetry: content.includes('retry') || content.includes('Retry'),
    hasCircuitBreaker: content.includes('circuit'),
    lineCount: content.split('\n').length,
    diagnosis: strategyInfo.description,
    ...strategyInfo,
  }
}

// ============================================
// Auto-Fix via Claude Code
// ============================================

async function runClaudeCodeFix(platform, diagnosis) {
  if (!AUTO_FIX_ENABLED) {
    console.log(`[auto-fix] DRY RUN — would fix ${platform} with strategy: ${diagnosis.strategy}`)
    return { success: false, dryRun: true, message: 'Auto-fix disabled (set AUTO_FIX_ENABLED=true)' }
  }

  const prompt = buildFixPrompt(platform, diagnosis)

  console.log(`[auto-fix] Launching Claude Code for ${platform}...`)
  console.log(`[auto-fix] 策略: ${diagnosis.strategy}`)
  console.log(`[auto-fix] 风险: ${diagnosis.risk}`)
  console.log(`[auto-fix] working dir: ${FIX_CWD}${FIX_CWD === OPENCLAW_WORKTREE ? ' (isolated worktree)' : ' (main checkout — no isolation)'}`)

  return new Promise((resolve) => {
    const startTime = Date.now()
    let output = ''

    const proc = spawn('claude', [
      '--print',
      '--dangerously-skip-permissions',
      prompt,
    ], {
      cwd: FIX_CWD,
      timeout: FIX_TIMEOUT_MS,
      env: { ...process.env },
    })

    proc.stdout.on('data', (data) => {
      output += data.toString()
    })

    proc.stderr.on('data', (data) => {
      output += data.toString()
    })

    proc.on('close', (code) => {
      const duration = Math.round((Date.now() - startTime) / 1000)
      resolve({
        success: code === 0,
        exitCode: code,
        duration,
        output: output.slice(-2000), // Last 2000 chars
      })
    })

    proc.on('error', (err) => {
      resolve({
        success: false,
        error: err.message,
        duration: Math.round((Date.now() - startTime) / 1000),
      })
    })
  })
}

function buildFixPrompt(platform, diagnosis) {
  const basePrompt = `Fix the failing fetcher for platform "${platform}".

Failure reason: ${diagnosis.diagnosis}
策略: ${diagnosis.strategy}
Fetcher file: ${diagnosis.fetcherPath}

RULES:
- Only modify the fetcher file and directly related files
- Do NOT modify shared.ts, index.ts, or other platform fetchers
- Keep changes minimal and focused
- Test your fix by checking that the code compiles: run "npx tsc --noEmit --pretty"
- After fixing, commit with message "fix(${platform}): <description>"
- You are running in an isolated worktree on branch openclaw/auto-fix.
  Push your commit to origin/openclaw/auto-fix (NOT main). A human/cron
  will merge to main separately via scripts/openclaw/merge-autofix-to-main.sh.`

  const strategyPrompts = {
    'proxy_fallback': `${basePrompt}

The API is geo-blocked. Fix by:
1. Import fetchWithFallback from './shared'
2. Replace direct fetchJson calls with fetchWithFallback
3. Ensure VPS_PROXY_URL env var is used as fallback
4. Keep direct fetch as primary (it works from some regions)`,

    'headers_or_proxy': `${basePrompt}

The API is blocked by WAF (Cloudflare/Akamai). Fix by:
1. Update User-Agent and headers to match a real browser
2. Add Referer and Origin headers matching the exchange's website
3. If that doesn't work, add CF Worker proxy fallback
4. Check if the CLOUDFLARE_PROXY_URL endpoint supports this exchange`,

    'api_discovery': `${basePrompt}

The API endpoint returned 404 — the exchange likely changed their API.
1. Read the current fetcher to understand what URL was used
2. Search for the exchange's current copy-trading or leaderboard API
3. The exchange may have versioned their API (v1 -> v2)
4. Update the URL and response parser to match the new format
5. If you can't find the new API, add error logging and return gracefully`,

    'backoff': `${basePrompt}

Getting rate-limited (429). Fix by:
1. Increase delay between requests (add sleep between pages)
2. Add exponential backoff on 429 responses
3. Reduce page size or number of concurrent requests
4. Consider adding a simple retry wrapper`,

    'response_update': `${basePrompt}

The API response format changed. Fix by:
1. Read the current parser logic in the fetcher
2. The response structure likely changed field names or nesting
3. Add defensive parsing with optional chaining
4. Log the raw response shape for debugging
5. Update the extractList and field mappings`,

    'timeout_increase': `${basePrompt}

Requests are timing out. Fix by:
1. Increase timeoutMs in fetchJson calls (try 20000-30000ms)
2. Add retry logic for timeout errors
3. Consider using fetchWithFallback for VPS proxy fallback`,
  }

  return strategyPrompts[diagnosis.strategy] || basePrompt
}

// ============================================
// Main
// ============================================

async function fixPlatform(platform, reason) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`[auto-fix] 平台: ${platform}`)
  console.log(`[auto-fix] 原因: ${reason || 'unknown'}`)
  console.log(`${'='.repeat(60)}`)

  // Step 1: Diagnose
  const diagnosis = diagnosePlatform(platform, reason)
  console.log(`[auto-fix] Diagnosis: ${diagnosis.diagnosis}`)
  console.log(`[auto-fix] 风险: ${diagnosis.risk}`)
  console.log(`[auto-fix] Auto-fixable: ${diagnosis.autoFixable}`)

  if (!diagnosis.autoFixable) {
    const msg = `<b>自动修复已跳过</b>\n\n` +
      `平台: <code>${platform}</code>\n` +
      `原因: ${diagnosis.diagnosis}\n` +
      `风险: ${diagnosis.risk}\n\n` +
      `<i>需要人工审查 — 此类故障不适合自动修复。</i>`
    await sendTelegram(msg)
    return { platform, skipped: true, reason: diagnosis.diagnosis }
  }

  // Step 2: Notify start
  await sendTelegram(
    `<b>自动修复开始</b>\n\n` +
    `平台: <code>${platform}</code>\n` +
    `策略: ${diagnosis.strategy}\n` +
    `描述: ${diagnosis.diagnosis}`
  )

  // Step 3: Run fix
  const result = await runClaudeCodeFix(platform, diagnosis)

  // Step 4: Report result
  if (result.dryRun) {
    console.log(`[自动修复] 试运行完成: ${platform}`)
    return { platform, dryRun: true, diagnosis }
  }

  if (result.success) {
    await sendTelegram(
      `<b>自动修复完成</b>\n\n` +
      `平台: <code>${platform}</code>\n` +
      `耗时: ${result.duration}s\n` +
      `策略: ${diagnosis.strategy}\n\n` +
      `<i>已本地提交。请审核后推送。</i>`
    )
  } else {
    await sendTelegram(
      `<b>自动修复失败</b>\n\n` +
      `平台: <code>${platform}</code>\n` +
      `耗时: ${result.duration}s\n` +
      `退出码: ${result.exitCode}\n\n` +
      `<pre>${(result.error || result.output || '').slice(0, 500)}</pre>\n\n` +
      `<i>需要人工干预。</i>`
    )
  }

  return { platform, ...result }
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.length === 0) {
    console.log(`
OpenClaw Auto-Fix — Diagnoses and fixes failing fetchers

Usage:
  node auto-fix.mjs <platform> [--reason <failure_reason>]
  node auto-fix.mjs --check-all

Options:
  --reason    Failure reason (geo_blocked, waf_blocked, endpoint_gone, rate_limited, auth_required, parse_error, timeout)
  --check-all Check all platforms via health API, fix any failing ones

Environment:
  AUTO_FIX_ENABLED=true   Enable actual fixes (default: dry-run)
  ARENA_DIR               Path to arena repo
  TELEGRAM_BOT_TOKEN      For notifications
  TELEGRAM_ALERT_CHAT_ID  Chat ID for notifications
  CRON_SECRET             For health API auth
`)
    process.exit(0)
  }

  if (args.includes('--check-all')) {
    console.log('[auto-fix] Checking all platforms...')

    try {
      const failing = await getFailingPlatforms()

      if (failing.length === 0) {
        console.log('[auto-fix] All platforms healthy!')
        return
      }

      console.log(`[auto-fix] Found ${failing.length} failing platform(s):`)
      for (const f of failing) {
        console.log(`  - ${f.platform}: ${f.status} (${f.lastError || 'no error message'})`)
      }

      // Fix each failing platform
      const results = []
      for (const f of failing) {
        const result = await fixPlatform(f.platform, f.lastError || 'unknown')
        results.push(result)
      }

      // Summary
      const fixed = results.filter((r) => r.success)
      const skipped = results.filter((r) => r.skipped)
      const failed = results.filter((r) => !r.success && !r.skipped && !r.dryRun)
      const dryRuns = results.filter((r) => r.dryRun)

      if (!AUTO_FIX_ENABLED) {
        console.log(`\n[auto-fix] DRY RUN Summary: ${results.length} platforms checked`)
        console.log(`  Would fix: ${dryRuns.length}`)
        console.log(`  Would skip: ${skipped.length}`)
      } else {
        console.log(`\n[auto-fix] Summary:`)
        console.log(`  Fixed: ${fixed.length}`)
        console.log(`  Skipped: ${skipped.length}`)
        console.log(`  Failed: ${failed.length}`)
      }
    } catch (err) {
      console.error('[auto-fix] Failed to check platforms:', err.message)
      process.exit(1)
    }
    return
  }

  // Single platform fix
  const platform = args[0]
  const reasonIdx = args.indexOf('--reason')
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : 'unknown'

  await fixPlatform(platform, reason)
}

main().catch((err) => {
  console.error('[auto-fix] Fatal error:', err)
  process.exit(1)
})
