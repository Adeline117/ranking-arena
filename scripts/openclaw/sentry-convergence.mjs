#!/usr/bin/env node
/**
 * Sentry Error Convergence — Weekly error analysis + actionable fix report
 *
 * Queries Sentry for top unresolved issues from the past week,
 * groups by root cause, and sends a Telegram summary with fix suggestions.
 *
 * Usage:
 *   node scripts/openclaw/sentry-convergence.mjs
 *   node scripts/openclaw/sentry-convergence.mjs --resolve-stale  (auto-resolve issues not seen in 30d)
 *
 * Environment:
 *   SENTRY_AUTH_TOKEN  - Sentry API auth token
 *   SENTRY_ORG         - Sentry organization slug
 *   SENTRY_PROJECT     - Sentry project slug
 *   TELEGRAM_BOT_TOKEN - For sending reports
 *   TELEGRAM_ALERT_CHAT_ID - Chat to send reports to
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'

const __dir = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dir, '../../.env') })

const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN || ''
const SENTRY_ORG = (process.env.SENTRY_ORG || '').replace(/\\n/g, '').trim()
const SENTRY_PROJECT = (process.env.SENTRY_PROJECT || 'javascript-nextjs').trim()
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID || ''
const RESOLVE_STALE = process.argv.includes('--resolve-stale')

if (!SENTRY_TOKEN || !SENTRY_ORG) {
  console.error('SENTRY_AUTH_TOKEN and SENTRY_ORG are required')
  process.exit(1)
}

const SENTRY_API = `https://sentry.io/api/0`

async function sentryFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${SENTRY_API}${endpoint}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${SENTRY_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sentry API ${res.status}: ${text}`)
  }
  return res.json()
}

async function getTopIssues() {
  // Get unresolved issues from the past 7 days, sorted by frequency
  const issues = await sentryFetch(
    `/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=is:unresolved&sort=freq&statsPeriod=14d&limit=25`
  )
  return issues
}

async function getStaleIssues() {
  // Issues not seen in 30 days
  const issues = await sentryFetch(
    `/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=is:unresolved+!is:assigned+lastSeen:-30d&sort=date&limit=50`
  )
  return issues
}

function categorizeIssue(issue) {
  const title = issue.title || ''
  const culprit = issue.culprit || ''

  if (title.includes('ChunkLoadError') || title.includes('Loading chunk')) return 'chunk-load'
  if (title.includes('NetworkError') || title.includes('fetch') || title.includes('Failed to fetch')) return 'network'
  if (title.includes('TypeError')) return 'type-error'
  if (title.includes('ReferenceError')) return 'reference-error'
  if (title.includes('hydration') || title.includes('Hydration')) return 'hydration'
  if (culprit.includes('api/') || culprit.includes('route.ts')) return 'api-error'
  if (title.includes('ResizeObserver')) return 'resize-observer'
  if (title.includes('AbortError') || title.includes('aborted')) return 'abort'
  return 'other'
}

function getSuggestion(category, issues) {
  const suggestions = {
    'chunk-load': 'Likely caused by deployment + cached old chunks. Consider adding retry logic or cache-busting.',
    'network': 'Client-side fetch failures. Check API availability, CORS, and add error boundaries.',
    'type-error': 'Null/undefined access. Check optional chaining and null guards.',
    'reference-error': 'Undefined variable access. Check imports and build output.',
    'hydration': 'SSR/client mismatch. Check conditional rendering, Date/random usage, browser-only APIs.',
    'api-error': 'Server-side route errors. Check error handling in API routes.',
    'resize-observer': 'Benign browser error. Can be safely ignored via Sentry beforeSend filter.',
    'abort': 'Navigation-triggered request cancellation. Generally benign.',
    'other': 'Review individually.',
  }
  return suggestions[category] || 'Review individually.'
}

async function resolveStaleIssues(staleIssues) {
  if (staleIssues.length === 0) return 0
  const ids = staleIssues.map(i => i.id)
  // Bulk resolve via Sentry API
  let resolved = 0
  for (const id of ids) {
    try {
      await sentryFetch(`/issues/${id}/`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'resolved', statusDetails: { inNextRelease: false } }),
      })
      resolved++
    } catch (e) {
      console.error(`Failed to resolve issue ${id}: ${e.message}`)
    }
  }
  return resolved
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
    console.log('No Telegram config, printing to stdout:')
    console.log(text)
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
  } catch (e) {
    console.error('Telegram send failed:', e.message)
    console.log(text)
  }
}

async function main() {
  console.log(`Sentry Convergence: org=${SENTRY_ORG}, project=${SENTRY_PROJECT}`)

  const [issues, staleIssues] = await Promise.all([
    getTopIssues(),
    RESOLVE_STALE ? getStaleIssues() : Promise.resolve([]),
  ])

  // Categorize
  const categories = {}
  for (const issue of issues) {
    const cat = categorizeIssue(issue)
    if (!categories[cat]) categories[cat] = []
    categories[cat].push(issue)
  }

  // Build report
  const lines = [`<b>Sentry Weekly Report</b>`, `${issues.length} unresolved issues (7d)\n`]

  const sorted = Object.entries(categories).sort((a, b) => b[1].length - a[1].length)
  for (const [cat, catIssues] of sorted) {
    const totalEvents = catIssues.reduce((sum, i) => sum + (parseInt(i.count) || 0), 0)
    lines.push(`<b>${cat}</b> (${catIssues.length} issues, ${totalEvents} events)`)
    lines.push(`  ${getSuggestion(cat, catIssues)}`)

    // Top 3 issues in each category
    const top = catIssues.slice(0, 3)
    for (const issue of top) {
      const count = issue.count || '?'
      const shortTitle = (issue.title || '').slice(0, 60)
      lines.push(`  - [${count}x] ${shortTitle}`)
    }
    lines.push('')
  }

  // Stale resolution
  if (RESOLVE_STALE && staleIssues.length > 0) {
    const resolved = await resolveStaleIssues(staleIssues)
    lines.push(`\nAuto-resolved ${resolved}/${staleIssues.length} stale issues (not seen in 30d)`)
  }

  const report = lines.join('\n')
  console.log(report)
  await sendTelegram(report)
  console.log('\nReport sent.')
}

main().catch(e => {
  console.error('Sentry convergence failed:', e)
  process.exit(1)
})
