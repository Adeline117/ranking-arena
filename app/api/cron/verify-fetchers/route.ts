/**
 * Verify Fetchers Cron Endpoint
 *
 * GET /api/cron/verify-fetchers
 *
 * Runs a lightweight health probe for every registered exchange API.
 * Each verifier makes a single minimal request (page=1, size=1) to check
 * reachability and response format without placing load on exchange servers.
 *
 * Logs per-platform results to pipeline_logs.
 * Alerts via sendAlert when a platform fails 3+ consecutive times.
 *
 * Schedule: every 3 hours (see vercel.json)
 */

import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/cron/utils'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { verifyAll, type VerifyResult } from '@/lib/cron/fetchers/verify-registry'

export const runtime = 'nodejs'
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const JOB_NAME = 'verify-fetchers'
const CONSECUTIVE_FAIL_THRESHOLD = 3

// Critical platforms that should always be monitored closely
const CRITICAL_PLATFORMS = new Set([
  'binance_futures',
  'bybit',
  'okx_futures',
  'hyperliquid',
])

export async function GET(request: Request) {
  // Auth check
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const pipelineLog = await PipelineLogger.start(JOB_NAME)

  try {
    const results: VerifyResult[] = await verifyAll()

    const healthy = results.filter((r: VerifyResult) => r.healthy)
    // Separate expected skips from real failures
    // - auth_required: missing API key (THEGRAPH_API_KEY, BITGET_API_KEY, etc.)
    // - endpoint_gone: platform API discontinued
    // - geo_blocked: blocked from verify region (sfo1) but works from fetcher region (hnd1)
    // - waf_blocked: Cloudflare WAF challenge — fetchers use proxy/browser headers to bypass
    const SKIP_REASONS = new Set(['auth_required', 'endpoint_gone', 'geo_blocked', 'waf_blocked'])
    const skipped = results.filter((r: VerifyResult) => !r.healthy && SKIP_REASONS.has(r.failureReason || ''))
    const failed = results.filter((r: VerifyResult) => !r.healthy && !SKIP_REASONS.has(r.failureReason || ''))

    logger.info(
      `[${JOB_NAME}] Completed: ${healthy.length} healthy, ${skipped.length} skipped, ${failed.length} failed (of ${results.length} total)`
    )

    // Log skipped platforms (informational only, no alerts)
    for (const result of skipped) {
      const jobKey = `verify-${result.platform}`
      const platformLog = await PipelineLogger.start(jobKey, {
        latencyMs: result.latencyMs,
        skipped: true,
      })
      await platformLog.success(0, {
        verifyResult: result as unknown as Record<string, unknown>,
        skipped: true,
      })
    }

    // Check consecutive failures and alert — only for real failures
    const alertsPlatforms: string[] = []

    for (const result of failed) {
      const jobKey = `verify-${result.platform}`

      // Log individual platform failure
      const platformLog = await PipelineLogger.start(jobKey, {
        failureReason: result.failureReason,
        latencyMs: result.latencyMs,
        details: result.details,
      })
      await platformLog.error(
        new Error(`${result.platform}: ${result.failureReason} - ${result.details || 'no details'}`),
        { verifyResult: result as unknown as Record<string, unknown> }
      )

      // Check consecutive failures with error classification
      const consecutiveFails = await PipelineLogger.getConsecutiveFailures(jobKey)

      // Error classification: permanent errors (auth) trigger faster, transient (500) slower
      const isPermanentError = result.failureReason === 'auth_failure' ||
        result.failureReason === 'forbidden' ||
        (result.details && /401|403/.test(result.details))
      const isTransientError = result.failureReason === 'server_error' ||
        result.failureReason === 'timeout' ||
        (result.details && /50[0-9]|timeout/i.test(result.details))

      // Permanent errors alert faster (2 failures), transient need more evidence
      const effectiveThreshold = isPermanentError ? 2 :
        isTransientError ? CONSECUTIVE_FAIL_THRESHOLD + 1 : CONSECUTIVE_FAIL_THRESHOLD

      if (consecutiveFails >= effectiveThreshold) {
        alertsPlatforms.push(result.platform)

        const isCritical = CRITICAL_PLATFORMS.has(result.platform)
        const level: 'critical' | 'warning' = isCritical ? 'critical' : 'warning'

        await sendAlert({
          title: `${result.platform} API 不可用`,
          message: [
            `平台: ${result.platform}`,
            `连续失败: ${consecutiveFails} 次`,
            `失败原因: ${result.failureReason || '未知'}`,
            `延迟: ${result.latencyMs}ms`,
            result.details ? `详情: ${result.details.slice(0, 200)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          level,
          details: {
            '平台': result.platform,
            '连续失败': consecutiveFails,
            '失败原因': result.failureReason || '未知',
            '延迟': `${result.latencyMs}ms`,
            '检查时间': result.checkedAt,
          },
        })
      }
    }

    // Log healthy platforms too (for streak tracking)
    for (const result of healthy) {
      const jobKey = `verify-${result.platform}`
      const platformLog = await PipelineLogger.start(jobKey, {
        latencyMs: result.latencyMs,
      })
      await platformLog.success(1, { verifyResult: result as unknown as Record<string, unknown> })
    }

    // Summary
    const summary = {
      total: results.length,
      healthy: healthy.length,
      skipped: skipped.length,
      failed: failed.length,
      alertsSent: alertsPlatforms.length,
      alertedPlatforms: alertsPlatforms,
      results: results.map((r: VerifyResult) => ({
        platform: r.platform,
        healthy: r.healthy,
        skipped: !r.healthy && SKIP_REASONS.has(r.failureReason || ''),
        failureReason: r.failureReason || null,
        latencyMs: r.latencyMs,
      })),
    }

    await pipelineLog.success(results.length, summary)

    return NextResponse.json(summary)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error(`[${JOB_NAME}] Fatal error: ${errorMessage}`)
    await pipelineLog.error(err)

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    )
  }
}
