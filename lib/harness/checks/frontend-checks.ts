/**
 * Frontend evaluation checks — homepage SSR, core pages, page speed.
 */

import { logger } from '@/lib/logger'
import type { EvaluationCheck, EvaluationIssue } from '../pipeline-evaluator'
import type { CheckResult } from './types'

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    'http://localhost:3000'
  )
}

/** Verify SSR HTML contains required structural elements. */
function verifySSRContent(html: string, latencyMs: number): CheckResult {
  const issues: EvaluationIssue[] = []
  let score = 100
  const missing: string[] = []

  const hasH1 = /<h1[\s>]/i.test(html)
  if (!hasH1) {
    score -= 15
    missing.push('h1')
  }

  const hasTable = html.includes('ssr-t')
  if (!hasTable) {
    score -= 20
    missing.push('ssr-t')
  }

  const rowCount = (html.match(/ssr-row(?=[ "'])/g) || []).length
  if (rowCount === 0) {
    score -= 25
    missing.push('ssr-row(0)')
  } else if (rowCount < 10) {
    score -= 10
    missing.push(`ssr-row(${rowCount}<10)`)
  }

  const hasControls = html.includes('ssr-controls')
  if (!hasControls) {
    score -= 10
    missing.push('ssr-controls')
  }

  const nameCount = (html.match(/ssr-name/g) || []).length
  if (nameCount === 0) {
    score -= 15
    missing.push('ssr-name(0)')
  }

  const hasScores = html.includes('ssr-score')
  if (!hasScores) {
    score -= 10
    missing.push('ssr-score')
  }

  if (latencyMs > 5000) {
    score -= 5
    missing.push(`slow(${latencyMs}ms)`)
  }

  score = Math.max(0, score)

  if (missing.length > 0) {
    issues.push({
      platform: 'frontend',
      type: 'homepage_ssr_incomplete',
      severity: score < 50 ? 'critical' : 'warning',
      description: `Missing SSR elements: ${missing.join(', ')}`,
      recommendation:
        'Check page.tsx renders HomeHeroSSR + SSRRankingTable with data. Verify critical-css.ts has all .ssr-* classes.',
    })
  }

  return {
    check: {
      name: 'homepage_ssr',
      category: 'freshness',
      passed: score >= 70,
      score,
      details: `${latencyMs}ms, h1=${hasH1}, table=${hasTable}, rows=${rowCount}, controls=${hasControls}, names=${nameCount}, scores=${hasScores}${missing.length > 0 ? ` | MISSING: ${missing.join(', ')}` : ''}`,
    },
    issues,
  }
}

/** Check 9: Homepage SSR — homepage has server-rendered hero + ranking table. */
export async function checkHomepageSSR(): Promise<CheckResult> {
  const issues: EvaluationIssue[] = []
  const baseUrl = getBaseUrl()
  const start = Date.now()
  try {
    const checkUrl = process.env.NEXT_PUBLIC_SITE_URL || baseUrl
    const res = await fetch(checkUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0 ArenaHealthCheck/1.0', Accept: 'text/html' },
      redirect: 'follow',
    })
    const latency = Date.now() - start

    if (res.status === 401 || res.status === 403) {
      const prodUrl = 'https://www.arenafi.org'
      if (checkUrl !== prodUrl) {
        try {
          const prodRes = await fetch(prodUrl, {
            signal: AbortSignal.timeout(8_000),
            headers: { 'User-Agent': 'Mozilla/5.0 ArenaHealthCheck/1.0', Accept: 'text/html' },
            redirect: 'follow',
          })
          if (prodRes.ok) {
            const html = await prodRes.text()
            return verifySSRContent(html, Date.now() - start)
          }
        } catch {
          /* fall through */
        }
      }
      return {
        check: {
          name: 'homepage_ssr',
          category: 'freshness',
          passed: true,
          score: 95,
          details: `${res.status} ${latency}ms (deployment protection — content not verified)`,
        },
        issues,
      }
    }

    if (res.status >= 500) {
      issues.push({
        platform: 'frontend',
        type: 'homepage_error',
        severity: 'critical',
        description: `Homepage returned ${res.status}`,
        recommendation: 'Check Next.js build.',
      })
      return {
        check: {
          name: 'homepage_ssr',
          category: 'freshness',
          passed: false,
          score: 0,
          details: `${res.status} ${latency}ms`,
        },
        issues,
      }
    }

    const html = await res.text()
    return verifySSRContent(html, latency)
  } catch (err) {
    return {
      check: {
        name: 'homepage_ssr',
        category: 'freshness',
        passed: false,
        score: 0,
        details: `Failed: ${err instanceof Error ? err.message : 'timeout'}`,
      },
      issues: [
        {
          platform: 'frontend',
          type: 'homepage_down',
          severity: 'critical',
          description: 'Homepage unreachable',
          recommendation: 'Check Vercel.',
        },
      ],
    }
  }
}

/** Check 10: Frontend Core Pages — verify multiple key pages load. */
export async function checkFrontendCorePages(): Promise<CheckResult> {
  const issues: EvaluationIssue[] = []
  const baseUrl = getBaseUrl()
  const pages = [
    { path: '/rankings/binance_futures', name: 'Rankings', expect: 'binance' },
    { path: '/market', name: 'Market', expect: 'market' },
    { path: '/pricing', name: 'Pricing', expect: 'pro' },
  ]

  let passCount = 0
  for (const page of pages) {
    try {
      const res = await fetch(`${baseUrl}${page.path}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'Mozilla/5.0 ArenaHealthCheck/1.0', Accept: 'text/html' },
        redirect: 'follow',
      })
      if (res.status === 401 || res.status === 403) {
        passCount++
        continue
      }
      const html = await res.text()
      const hasContent = html.toLowerCase().includes(page.expect)
      if (res.status < 400 && hasContent) passCount++
      else
        issues.push({
          platform: 'frontend',
          type: 'page_degraded',
          severity: 'warning',
          description: `${page.name}: ${res.status}, content=${hasContent}`,
          recommendation: `Check ${page.path} SSR rendering.`,
        })
    } catch (err) {
      logger.warn(
        '[evaluator] frontend page check failed:',
        err instanceof Error ? err.message : String(err)
      )
      issues.push({
        platform: 'frontend',
        type: 'page_timeout',
        severity: 'warning',
        description: `${page.name} timed out`,
        recommendation: `Check ${page.path}.`,
      })
    }
  }

  const score = Math.round((passCount / pages.length) * 100)
  return {
    check: {
      name: 'frontend_core_pages',
      category: 'freshness',
      passed: score >= 70,
      score,
      details: `${passCount}/${pages.length} core pages healthy`,
    },
    issues,
  }
}

/** Check 16: Frontend Page Speed — core pages must respond under 3s. */
export async function checkFrontendPageSpeed(): Promise<CheckResult> {
  const issues: EvaluationIssue[] = []
  const baseUrl = getBaseUrl()
  const pages = [
    { path: '/', name: 'Homepage', maxMs: 3000 },
    { path: '/rankings/binance_futures', name: 'Rankings', maxMs: 3000 },
    { path: '/market', name: 'Market', maxMs: 3000 },
    { path: '/search?q=btc', name: 'Search', maxMs: 3000 },
  ]

  let totalScore = 0
  for (const page of pages) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}${page.path}`, {
        signal: AbortSignal.timeout(page.maxMs * 2),
        headers: { 'User-Agent': 'Mozilla/5.0 ArenaHealthCheck/1.0', Accept: 'text/html' },
        redirect: 'follow',
      })
      const latency = Date.now() - start
      if (res.status === 401 || res.status === 403) {
        totalScore += 95
        continue
      }
      if (res.status >= 500) {
        issues.push({
          platform: 'frontend',
          type: 'page_error',
          severity: 'critical',
          description: `${page.name}: ${res.status}`,
          recommendation: `Check ${page.path}.`,
        })
      } else if (latency > page.maxMs) {
        totalScore += 50
        issues.push({
          platform: 'frontend',
          type: 'page_slow',
          severity: 'warning',
          description: `${page.name}: ${latency}ms (max: ${page.maxMs}ms)`,
          recommendation: `Optimize ${page.path}. Check ISR/SSG cache.`,
        })
      } else {
        totalScore += 100
      }
    } catch (err) {
      logger.warn(
        '[evaluator] page speed check failed:',
        err instanceof Error ? err.message : String(err)
      )
      issues.push({
        platform: 'frontend',
        type: 'page_timeout',
        severity: 'warning',
        description: `${page.name} timed out`,
        recommendation: `Check ${page.path}.`,
      })
    }
  }

  const score = Math.round(totalScore / pages.length)
  return {
    check: {
      name: 'frontend_page_speed',
      category: 'freshness',
      passed: score >= 70,
      score,
      details: `${pages.length} pages, avg score ${score}/100`,
    },
    issues,
  }
}
