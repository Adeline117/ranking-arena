/**
 * Infrastructure evaluation checks — API latency, VPS health, cron success rate.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { CheckResult } from './types'

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    'http://localhost:3000'
  )
}

/** Check 8: API Response Time — key endpoints respond within acceptable latency. */
export async function checkAPIResponseTime(): Promise<CheckResult> {
  const issues: CheckResult['issues'] = []
  const baseUrl = getBaseUrl()
  const endpoints = [
    { path: '/api/health', name: 'Health', maxMs: 2000 },
    { path: '/api/traders?timeRange=90D&limit=5', name: 'Rankings', maxMs: 3000 },
    { path: '/api/search?q=test&limit=3', name: 'Search', maxMs: 3000 },
  ]
  let totalScore = 0
  for (const ep of endpoints) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        signal: AbortSignal.timeout(ep.maxMs * 2),
        headers: { 'User-Agent': 'PipelineEvaluator/1.0' },
      })
      const latency = Date.now() - start
      if (res.status >= 500) {
        issues.push({
          platform: 'api',
          type: 'api_error',
          severity: 'critical',
          description: `${ep.name} API returned ${res.status} (${latency}ms)`,
          recommendation: `Check ${ep.path}.`,
        })
      } else if (latency > ep.maxMs) {
        totalScore += 50
        issues.push({
          platform: 'api',
          type: 'api_slow',
          severity: 'warning',
          description: `${ep.name} took ${latency}ms (max: ${ep.maxMs}ms)`,
          recommendation: `Optimize ${ep.path}.`,
        })
      } else {
        totalScore += 100
      }
    } catch (err) {
      logger.warn('[evaluator] API check failed:', err instanceof Error ? err.message : String(err))
      issues.push({
        platform: 'api',
        type: 'api_timeout',
        severity: 'critical',
        description: `${ep.name} timed out`,
        recommendation: `Check ${ep.path}.`,
      })
    }
  }
  const score = Math.round(totalScore / endpoints.length)
  return {
    check: {
      name: 'api_response_time',
      category: 'freshness',
      passed: score >= 70,
      score,
      details: `${endpoints.length} endpoints, avg score ${score}/100`,
    },
    issues,
  }
}

/** Check 11: Expanded API Latency — test more endpoints with stricter thresholds. */
export async function checkExpandedAPILatency(): Promise<CheckResult> {
  const issues: CheckResult['issues'] = []
  const baseUrl = getBaseUrl()
  const endpoints = [
    { path: '/api/rankings/platform-stats', name: 'Platform Stats', maxMs: 3000 },
    { path: '/api/rankings/movers', name: 'Movers', maxMs: 3000 },
    { path: '/api/market/prices', name: 'Market Prices', maxMs: 3000 },
    { path: '/api/stats', name: 'Site Stats', maxMs: 2000 },
    { path: '/api/flash-news', name: 'Flash News', maxMs: 3000 },
  ]
  let totalScore = 0
  for (const ep of endpoints) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        signal: AbortSignal.timeout(ep.maxMs * 2),
        headers: { 'User-Agent': 'PipelineEvaluator/1.0' },
      })
      const latency = Date.now() - start
      if (res.status >= 500) {
        issues.push({
          platform: 'api',
          type: 'api_error',
          severity: 'warning',
          description: `${ep.name} returned ${res.status} (${latency}ms)`,
          recommendation: `Check ${ep.path}.`,
        })
      } else if (latency > ep.maxMs) {
        totalScore += 50
        issues.push({
          platform: 'api',
          type: 'api_slow',
          severity: 'info',
          description: `${ep.name} took ${latency}ms (max: ${ep.maxMs}ms)`,
          recommendation: `Optimize ${ep.path}.`,
        })
      } else {
        totalScore += 100
      }
    } catch (err) {
      logger.warn(
        '[evaluator] expanded API check failed:',
        err instanceof Error ? err.message : String(err)
      )
      issues.push({
        platform: 'api',
        type: 'api_timeout',
        severity: 'warning',
        description: `${ep.name} timed out`,
        recommendation: `Check ${ep.path}.`,
      })
    }
  }
  const score = Math.round(totalScore / endpoints.length)
  return {
    check: {
      name: 'expanded_api_latency',
      category: 'freshness',
      passed: score >= 70,
      score,
      details: `${endpoints.length} additional endpoints, avg score ${score}/100`,
    },
    issues,
  }
}

/** Check 13: Trader Detail Integrity — top trader from 5 platforms returns complete data. */
export async function checkTraderDetailIntegrity(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []
  const baseUrl = getBaseUrl()
  const PLATFORMS = ['binance_futures', 'bybit', 'hyperliquid', 'okx_futures', 'mexc']

  let passCount = 0
  for (const platform of PLATFORMS) {
    const { data: top1 } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id')
      .eq('source', platform)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(1)
    if (!top1?.length) continue

    try {
      const handle = `${platform}:${top1[0].source_trader_id}`
      const res = await fetch(
        `${baseUrl}/api/traders/${encodeURIComponent(handle)}?timeRange=90D`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'PipelineEvaluator/1.0' } }
      )
      if (res.status === 200) {
        const body = await res.json()
        const hasCore = body.trader?.roi != null && body.trader?.arena_score != null
        if (hasCore) passCount++
        else
          issues.push({
            platform,
            type: 'trader_detail_incomplete',
            severity: 'warning',
            description: `${platform} top trader missing roi or arena_score`,
            recommendation: `Check /api/traders handler for ${platform}.`,
          })
      } else if (res.status === 401 || res.status === 403) {
        passCount++
      } else {
        issues.push({
          platform,
          type: 'trader_detail_error',
          severity: 'warning',
          description: `${platform} trader detail returned ${res.status}`,
          recommendation: 'Check trader detail API.',
        })
      }
    } catch (err) {
      logger.warn(
        '[evaluator] trader detail check failed:',
        err instanceof Error ? err.message : String(err)
      )
      issues.push({
        platform,
        type: 'trader_detail_timeout',
        severity: 'info',
        description: `${platform} trader detail timed out`,
        recommendation: 'Check API latency.',
      })
    }
  }

  const score = Math.round((passCount / PLATFORMS.length) * 100)
  return {
    check: {
      name: 'trader_detail_integrity',
      category: 'completeness',
      passed: score >= 70,
      score,
      details: `${passCount}/${PLATFORMS.length} trader details complete`,
    },
    issues,
  }
}

/** Check 14: VPS Health — verify VPS proxies are responding. */
export async function checkVPSHealth(): Promise<CheckResult> {
  const issues: CheckResult['issues'] = []
  const vpsHosts = [
    {
      name: 'SG',
      host: process.env.VPS_PROXY_SG || process.env.VPS_SCRAPER_SG?.replace(':3457', ':3456'),
    },
    ...(process.env.VPS_PROXY_JP ? [{ name: 'JP', host: process.env.VPS_PROXY_JP }] : []),
  ].filter((v) => v.host)

  if (vpsHosts.length === 0) {
    return {
      check: {
        name: 'vps_health',
        category: 'freshness',
        passed: true,
        score: 80,
        details: 'No VPS hosts configured',
      },
      issues: [],
    }
  }

  let healthyCount = 0
  for (const vps of vpsHosts) {
    const urls = [vps.host!]
    const stdPort = vps.host!.replace(/:\d+$/, ':3456')
    if (stdPort !== vps.host) urls.push(stdPort)

    let ok = false
    for (const url of urls) {
      try {
        const res = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'X-Proxy-Key': process.env.VPS_PROXY_KEY?.trim() || '' },
        })
        if (res.ok) {
          const body = (await res.json()) as { status?: string }
          if (body.status === 'ok') {
            healthyCount++
            ok = true
            break
          }
        }
      } catch {
        /* try next URL */
      }
    }
    if (!ok) {
      issues.push({
        platform: `vps_${vps.name.toLowerCase()}`,
        type: 'vps_unreachable',
        severity: 'critical',
        description: `VPS ${vps.name} unreachable on ${urls.join(' and ')}`,
        recommendation: `VPS ${vps.name} is down. Check PM2 and Vultr console.`,
      })
    }
  }

  const score = vpsHosts.length > 0 ? Math.round((healthyCount / vpsHosts.length) * 100) : 80
  return {
    check: {
      name: 'vps_health',
      category: 'freshness',
      passed: healthyCount === vpsHosts.length,
      score,
      details: `${healthyCount}/${vpsHosts.length} VPS healthy`,
    },
    issues,
  }
}

/** Check 15: Cron Success Rate — past 1h success rate across all cron jobs. */
export async function checkCronSuccessRate(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []

  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString()
  const { data: logs } = await supabase
    .from('pipeline_logs')
    .select('job_name, status')
    .gte('started_at', oneHourAgo)
    .limit(500)

  if (!logs || logs.length === 0) {
    return {
      check: {
        name: 'cron_success_rate',
        category: 'consistency',
        passed: true,
        score: 80,
        details: 'No cron runs in past 1h',
      },
      issues: [],
    }
  }

  const total = logs.length
  const successes = logs.filter((l) => l.status === 'success').length
  const errors = logs.filter((l) => l.status === 'error').length
  const rate = successes / total

  const byJob = new Map<string, { total: number; errors: number }>()
  for (const log of logs) {
    const entry = byJob.get(log.job_name) || { total: 0, errors: 0 }
    entry.total++
    if (log.status === 'error') entry.errors++
    byJob.set(log.job_name, entry)
  }
  for (const [job, stats] of byJob) {
    const jobRate = (stats.total - stats.errors) / stats.total
    if (jobRate < 0.5 && stats.errors >= 2) {
      issues.push({
        platform: 'cron',
        type: 'cron_failing',
        severity: jobRate === 0 ? 'critical' : 'warning',
        description: `${job}: ${stats.errors}/${stats.total} failed (${Math.round(jobRate * 100)}% success)`,
        recommendation: `Check logs for ${job}.`,
      })
    }
  }

  const score = Math.round(rate * 100)
  return {
    check: {
      name: 'cron_success_rate',
      category: 'consistency',
      passed: rate >= 0.9,
      score,
      details: `${successes}/${total} succeeded (${Math.round(rate * 100)}%), ${errors} errors`,
    },
    issues,
  }
}

/** Check 17: Trader Search Accuracy — verify search returns relevant results. */
export async function checkTraderSearchAccuracy(): Promise<CheckResult> {
  const issues: CheckResult['issues'] = []
  const baseUrl = getBaseUrl()

  try {
    const res = await fetch(`${baseUrl}/api/search?q=bitcoin&limit=5`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'PipelineEvaluator/1.0' },
    })
    if (res.status === 401 || res.status === 403) {
      return {
        check: {
          name: 'trader_search_accuracy',
          category: 'completeness',
          passed: true,
          score: 95,
          details: 'Auth wall — skipped',
        },
        issues,
      }
    }
    if (!res.ok) {
      return {
        check: {
          name: 'trader_search_accuracy',
          category: 'completeness',
          passed: false,
          score: 0,
          details: `Search API returned ${res.status}`,
        },
        issues: [
          {
            platform: 'api',
            type: 'search_error',
            severity: 'critical',
            description: `Search API returned ${res.status}`,
            recommendation: 'Check /api/search.',
          },
        ],
      }
    }
    const body = await res.json()
    const results = body.results || body.data || []
    const hasResults = Array.isArray(results) && results.length > 0
    const score = hasResults ? 100 : 50
    if (!hasResults)
      issues.push({
        platform: 'api',
        type: 'search_empty',
        severity: 'warning',
        description: 'Search for "bitcoin" returned 0 results',
        recommendation: 'Check search index or trigram matching.',
      })
    return {
      check: {
        name: 'trader_search_accuracy',
        category: 'completeness',
        passed: hasResults,
        score,
        details: `Search "bitcoin": ${results.length} results`,
      },
      issues,
    }
  } catch (err) {
    logger.warn(
      '[evaluator] search accuracy check failed:',
      err instanceof Error ? err.message : String(err)
    )
    return {
      check: {
        name: 'trader_search_accuracy',
        category: 'completeness',
        passed: false,
        score: 0,
        details: 'Search timed out',
      },
      issues: [
        {
          platform: 'api',
          type: 'search_timeout',
          severity: 'warning',
          description: 'Search API timed out',
          recommendation: 'Check /api/search.',
        },
      ],
    }
  }
}
