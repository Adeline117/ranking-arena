/**
 * Pipeline Health Service
 *
 * Tracks consecutive failures per platform, classifies errors,
 * and triggers alerts when thresholds are breached.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { FailureReason } from '@/lib/cron/fetchers/shared'

// In-memory failure counter (resets on cold start, but that's fine —
// pipeline_metrics in DB provides durable history)
const failureCounts = new Map<string, number>()
const ALERT_THRESHOLD = 3

export interface PipelineHealthRecord {
  platform: string
  status: 'success' | 'error'
  failure_reason: FailureReason | null
  trader_count: number
  duration_ms: number
  via: 'direct' | 'cf_proxy' | 'vps_proxy' | null
  error_message: string | null
  periods: Record<string, { total: number; saved: number; error?: string }>
}

export async function recordPipelineHealth(
  supabase: SupabaseClient,
  record: PipelineHealthRecord
): Promise<void> {
  const { platform, status } = record

  // Update consecutive failure counter
  if (status === 'error') {
    const count = (failureCounts.get(platform) || 0) + 1
    failureCounts.set(platform, count)

    if (count >= ALERT_THRESHOLD) {
      await sendPipelineAlert(supabase, platform, count, record)
    }
  } else {
    failureCounts.set(platform, 0)
  }

  // Write to pipeline_metrics (existing table)
  try {
    const metricType = status === 'success' ? 'fetch_success' : 'fetch_error'
    await supabase.from('pipeline_metrics').insert({
      source: platform,
      metric_type: metricType,
      value: status === 'success' ? record.trader_count : 1,
      metadata: {
        failure_reason: record.failure_reason,
        via: record.via,
        duration_ms: record.duration_ms,
        periods: record.periods,
        error: record.error_message?.slice(0, 500),
        consecutive_failures: failureCounts.get(platform) || 0,
      },
    })
  } catch (err) {
    logger.warn(`[pipeline-health] Failed to record metric: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function sendPipelineAlert(
  supabase: SupabaseClient,
  platform: string,
  consecutiveFailures: number,
  record: PipelineHealthRecord
): Promise<void> {
  const reason = record.failure_reason || 'unknown'
  const suggestion = getFixSuggestion(reason)

  const message = [
    `🚨 Pipeline Alert: ${platform}`,
    `Consecutive failures: ${consecutiveFailures}`,
    `Reason: ${reason}`,
    `Error: ${record.error_message?.slice(0, 200) || 'N/A'}`,
    `Suggestion: ${suggestion}`,
  ].join('\n')

  logger.error(`[pipeline-health] ${message}`)

  // Try Telegram alert
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN
  const telegramChatId = process.env.TELEGRAM_ALERT_CHAT_ID
  if (telegramToken && telegramChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: message,
          parse_mode: 'HTML',
        }),
      })
    } catch {
      // Don't let alert failure break the pipeline
    }
  }

  // Also record alert in pipeline_metrics
  try {
    await supabase.from('pipeline_metrics').insert({
      source: platform,
      metric_type: 'alert_sent',
      value: consecutiveFailures,
      metadata: { failure_reason: reason, suggestion },
    })
  } catch {
    // ignore
  }
}

function getFixSuggestion(reason: FailureReason): string {
  switch (reason) {
    case 'geo_blocked':
      return 'Set VPS_PROXY_URL to route through Tokyo/Singapore VPS'
    case 'waf_blocked':
      return 'Exchange WAF blocks server IPs. Use VPS proxy or update user-agent/headers'
    case 'auth_required':
      return 'API requires authentication. Set exchange API key env vars'
    case 'endpoint_gone':
      return 'API endpoint changed. Check exchange docs and update fetcher'
    case 'rate_limited':
      return 'Rate limited. Reduce fetch frequency or add delays'
    case 'timeout':
      return 'Request timed out. Check network or increase timeout'
    case 'empty_data':
      return 'API returned empty data. Schema may have changed'
    case 'parse_error':
      return 'Response parsing failed. API format may have changed'
    default:
      return 'Unknown error. Check logs for details'
  }
}

export function getConsecutiveFailures(platform: string): number {
  return failureCounts.get(platform) || 0
}
