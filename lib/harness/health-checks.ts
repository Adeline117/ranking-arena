/**
 * Comprehensive Health Checks — frontend, API, and data quality.
 *
 * Three check categories:
 * 1. Frontend: Core page load + SSR data verification
 * 2. API: All public endpoints respond with expected shapes
 * 3. Data Quality: Ranking consistency, anomalies, coverage
 *
 * Used by /api/cron/health-check-all and /api/health/comprehensive
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

// ── Types ────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string
  category: 'frontend' | 'api' | 'data_quality'
  status: 'pass' | 'warn' | 'fail'
  latency_ms: number
  details: string
}

export interface HealthReport {
  overall: 'healthy' | 'degraded' | 'critical'
  score: number // 0-100
  checks: HealthCheck[]
  checked_at: string
  duration_ms: number
}

// ── Frontend Health Checks ───────────────────────────────────────

const CORE_PAGES = [
  { path: '/', name: 'Homepage', expectSSR: 'Track' },
  { path: '/rankings/binance_futures', name: 'Rankings (Binance)', expectSSR: 'binance' },
  { path: '/market', name: 'Market Overview', expectSSR: 'market' },
  { path: '/search?q=test', name: 'Search', expectSSR: 'search' },
  { path: '/pricing', name: 'Pricing', expectSSR: 'Pro' },
]

export async function checkFrontendHealth(baseUrl: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []

  const results = await Promise.allSettled(
    CORE_PAGES.map(async (page) => {
      const start = Date.now()
      try {
        const res = await fetch(`${baseUrl}${page.path}`, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'User-Agent': 'ArenaHealthCheck/1.0' },
        })
        const latency = Date.now() - start
        const html = await res.text()

        // Check SSR content
        const hasSSRContent = page.expectSSR
          ? html.toLowerCase().includes(page.expectSSR.toLowerCase())
          : true

        let status: 'pass' | 'warn' | 'fail' = 'pass'
        let details = `${res.status} ${latency}ms`

        if (res.status >= 500) {
          status = 'fail'
          details = `HTTP ${res.status}`
        } else if (res.status >= 400) {
          status = 'warn'
          details = `HTTP ${res.status}`
        } else if (latency > 5000) {
          status = 'warn'
          details = `Slow: ${latency}ms`
        } else if (!hasSSRContent) {
          status = 'warn'
          details = `Missing SSR content (expected "${page.expectSSR}")`
        }

        return { name: `page:${page.name}`, category: 'frontend' as const, status, latency_ms: latency, details }
      } catch (err) {
        return {
          name: `page:${page.name}`,
          category: 'frontend' as const,
          status: 'fail' as const,
          latency_ms: Date.now() - start,
          details: err instanceof Error ? err.message : 'Timeout',
        }
      }
    })
  )

  for (const r of results) {
    if (r.status === 'fulfilled') checks.push(r.value)
    else checks.push({ name: 'page:unknown', category: 'frontend', status: 'fail', latency_ms: 0, details: String(r.reason) })
  }

  return checks
}

// ── API Health Checks ────────────────────────────────────────────

const API_ENDPOINTS = [
  { path: '/api/traders?timeRange=90D&limit=5', name: 'Rankings API', expectKey: 'data' },
  { path: '/api/rankings/platform-stats', name: 'Platform Stats', expectKey: 'platforms' },
  { path: '/api/rankings/movers', name: 'Movers API', expectKey: 'movers' },
  { path: '/api/search?q=test&limit=3', name: 'Search API', expectKey: 'results' },
  { path: '/api/market/prices', name: 'Market Prices', expectKey: null },
  { path: '/api/health', name: 'Health Endpoint', expectKey: 'status' },
  { path: '/api/flash-news', name: 'Flash News', expectKey: null },
  { path: '/api/stats', name: 'Site Stats', expectKey: null },
]

export async function checkAPIHealth(baseUrl: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []

  const results = await Promise.allSettled(
    API_ENDPOINTS.map(async (ep) => {
      const start = Date.now()
      try {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'User-Agent': 'ArenaHealthCheck/1.0' },
        })
        const latency = Date.now() - start
        const body = await res.json().catch(() => null)

        let status: 'pass' | 'warn' | 'fail' = 'pass'
        let details = `${res.status} ${latency}ms`

        if (res.status >= 500) {
          status = 'fail'
          details = `HTTP ${res.status}`
        } else if (res.status >= 400) {
          status = 'warn'
          details = `HTTP ${res.status}`
        } else if (latency > 3000) {
          status = 'warn'
          details = `Slow: ${latency}ms`
        } else if (ep.expectKey && body && !(ep.expectKey in body)) {
          status = 'warn'
          details = `Missing key "${ep.expectKey}" in response`
        }

        return { name: `api:${ep.name}`, category: 'api' as const, status, latency_ms: latency, details }
      } catch (err) {
        return {
          name: `api:${ep.name}`,
          category: 'api' as const,
          status: 'fail' as const,
          latency_ms: Date.now() - start,
          details: err instanceof Error ? err.message : 'Timeout',
        }
      }
    })
  )

  for (const r of results) {
    if (r.status === 'fulfilled') checks.push(r.value)
    else checks.push({ name: 'api:unknown', category: 'api', status: 'fail', latency_ms: 0, details: String(r.reason) })
  }

  return checks
}

// ── Data Quality Checks ──────────────────────────────────────────

export async function checkDataQuality(): Promise<HealthCheck[]> {
  const supabase = getSupabaseAdmin()
  const checks: HealthCheck[] = []

  // Run all checks in parallel
  const results = await Promise.allSettled([
    // Check 1: Ranking consistency — top 10 should have descending arena_score
    (async () => {
      const start = Date.now()
      const { data: top10 } = await supabase
        .from('leaderboard_ranks')
        .select('rank, arena_score, source')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .order('rank', { ascending: true })
        .limit(10)

      let sorted = true
      if (top10 && top10.length > 1) {
        for (let i = 1; i < top10.length; i++) {
          if ((top10[i].arena_score ?? 0) > (top10[i - 1].arena_score ?? 0)) {
            sorted = false
            break
          }
        }
      }

      return {
        name: 'dq:ranking_order',
        category: 'data_quality' as const,
        status: sorted ? 'pass' as const : 'fail' as const,
        latency_ms: Date.now() - start,
        details: sorted ? 'Top 10 rankings correctly ordered' : 'Ranking order inconsistency detected',
      }
    })(),

    // Check 2: No duplicate trader in same period
    (async () => {
      const start = Date.now()
      let dupeCheck: number | null = null
      try {
        const { data } = await supabase.rpc('check_leaderboard_duplicates')
        dupeCheck = data as number | null
      } catch {
        dupeCheck = null
      }

      // Fallback: sample check
      if (dupeCheck === null) {
        const { data: sample } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, season_id')
          .eq('season_id', '90D')
          .order('updated_at', { ascending: false })
          .limit(500)

        const seen = new Set<string>()
        let dupes = 0
        for (const r of sample || []) {
          const key = `${r.source}:${r.source_trader_id}`
          if (seen.has(key)) dupes++
          seen.add(key)
        }

        return {
          name: 'dq:no_duplicates',
          category: 'data_quality' as const,
          status: dupes === 0 ? 'pass' as const : 'fail' as const,
          latency_ms: Date.now() - start,
          details: dupes === 0 ? 'No duplicates in sample' : `${dupes} duplicates found in top 500`,
        }
      }

      return {
        name: 'dq:no_duplicates',
        category: 'data_quality' as const,
        status: (dupeCheck as number) === 0 ? 'pass' as const : 'fail' as const,
        latency_ms: Date.now() - start,
        details: `${dupeCheck} duplicates`,
      }
    })(),

    // Check 3: Platform coverage — all active platforms have data
    (async () => {
      const start = Date.now()
      const { data: platforms } = await supabase
        .from('leaderboard_ranks')
        .select('source')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .limit(50000)

      const uniquePlatforms = new Set((platforms || []).map(p => p.source))
      const count = uniquePlatforms.size

      return {
        name: 'dq:platform_coverage',
        category: 'data_quality' as const,
        status: count >= 20 ? 'pass' as const : count >= 15 ? 'warn' as const : 'fail' as const,
        latency_ms: Date.now() - start,
        details: `${count} platforms with data in 90D leaderboard`,
      }
    })(),

    // Check 4: No extreme anomalies in top 100
    (async () => {
      const start = Date.now()
      const { data: top100 } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, roi, arena_score, win_rate, max_drawdown, trades_count')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .order('rank', { ascending: true })
        .limit(100)

      let anomalies = 0
      const issues: string[] = []
      for (const t of top100 || []) {
        // ROI > 50000% is suspicious
        if (t.roi != null && (t.roi > 50000 || t.roi < -100)) {
          anomalies++
          issues.push(`${t.source}:${t.source_trader_id} ROI=${t.roi}%`)
        }
        // Arena score > 100 shouldn't happen
        if (t.arena_score != null && t.arena_score > 100) {
          anomalies++
          issues.push(`${t.source}:${t.source_trader_id} score=${t.arena_score}`)
        }
        // Top 50 with <3 trades is suspicious
        if (t.trades_count != null && t.trades_count < 3) {
          anomalies++
          issues.push(`${t.source}:${t.source_trader_id} trades=${t.trades_count}`)
        }
      }

      return {
        name: 'dq:anomaly_check',
        category: 'data_quality' as const,
        status: anomalies === 0 ? 'pass' as const : anomalies <= 3 ? 'warn' as const : 'fail' as const,
        latency_ms: Date.now() - start,
        details: anomalies === 0
          ? 'No anomalies in top 100'
          : `${anomalies} anomalies: ${issues.slice(0, 3).join(', ')}`,
      }
    })(),

    // Check 5: Data freshness — leaderboard should be updated within 2 hours
    (async () => {
      const start = Date.now()
      const { data: latest } = await supabase
        .from('leaderboard_ranks')
        .select('updated_at')
        .eq('season_id', '90D')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const age = latest ? Date.now() - new Date(latest.updated_at).getTime() : Infinity
      const ageHours = age / 3600000

      return {
        name: 'dq:freshness',
        category: 'data_quality' as const,
        status: ageHours < 2 ? 'pass' as const : ageHours < 6 ? 'warn' as const : 'fail' as const,
        latency_ms: Date.now() - start,
        details: `Leaderboard last updated ${ageHours.toFixed(1)}h ago`,
      }
    })(),

    // Check 6: 7D/30D/90D consistency — trader count shouldn't vary wildly
    (async () => {
      const start = Date.now()
      const counts: Record<string, number> = {}

      for (const period of ['7D', '30D', '90D']) {
        const { count } = await supabase
          .from('leaderboard_ranks')
          .select('*', { count: 'exact', head: true })
          .eq('season_id', period)
          .not('arena_score', 'is', null)
        counts[period] = count ?? 0
      }

      // 7D should be at least 50% of 90D (some traders may not have 7D data)
      const ratio7d = counts['90D'] > 0 ? counts['7D'] / counts['90D'] : 1
      const isConsistent = ratio7d >= 0.3

      return {
        name: 'dq:period_consistency',
        category: 'data_quality' as const,
        status: isConsistent ? 'pass' as const : 'warn' as const,
        latency_ms: Date.now() - start,
        details: `7D: ${counts['7D']}, 30D: ${counts['30D']}, 90D: ${counts['90D']} (ratio 7D/90D: ${(ratio7d * 100).toFixed(0)}%)`,
      }
    })(),
  ])

  for (const r of results) {
    if (r.status === 'fulfilled') checks.push(r.value)
    else {
      logger.warn('[health-checks] Data quality check failed:', r.reason)
      checks.push({ name: 'dq:error', category: 'data_quality', status: 'fail', latency_ms: 0, details: String(r.reason) })
    }
  }

  return checks
}

// ── Combined Report ──────────────────────────────────────────────

export async function runFullHealthCheck(baseUrl: string): Promise<HealthReport> {
  const startTime = Date.now()

  // Run all categories in parallel — surface crash as explicit FAIL check instead of silent []
  const categoryMap = { frontend: 'frontend', api: 'api', data: 'data_quality' } as const
  const wrapCategory = (name: keyof typeof categoryMap, fn: Promise<HealthCheck[]>): Promise<HealthCheck[]> =>
    fn.catch((err): HealthCheck[] => [{
      name: `${name}_crash`,
      category: categoryMap[name],
      status: 'fail',
      details: `Health check category crashed: ${err instanceof Error ? err.message : String(err)}`,
      latency_ms: 0,
    }])

  const [frontendChecks, apiChecks, dataChecks] = await Promise.all([
    wrapCategory('frontend', checkFrontendHealth(baseUrl)),
    wrapCategory('api', checkAPIHealth(baseUrl)),
    wrapCategory('data', checkDataQuality()),
  ])

  const allChecks = [...frontendChecks, ...apiChecks, ...dataChecks]

  // Calculate score
  const passCount = allChecks.filter(c => c.status === 'pass').length
  const warnCount = allChecks.filter(c => c.status === 'warn').length
  const failCount = allChecks.filter(c => c.status === 'fail').length
  const total = allChecks.length || 1
  const score = Math.round(((passCount * 100 + warnCount * 50) / total))

  let overall: 'healthy' | 'degraded' | 'critical' = 'healthy'
  if (failCount > 0 || score < 60) overall = 'critical'
  else if (warnCount > 2 || score < 80) overall = 'degraded'

  return {
    overall,
    score,
    checks: allChecks,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
  }
}
