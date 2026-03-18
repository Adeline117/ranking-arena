/**
 * k6 Load Test for Arena API
 *
 * Tests key API endpoints under load to find performance limits.
 * Inspired by grafana/k6 (30.1K★).
 *
 * Usage:
 *   k6 run scripts/load-test.js
 *   k6 run --vus 50 --duration 60s scripts/load-test.js
 *
 * Targets: rankings, search, trader detail, market data
 */

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

// Custom metrics
const errorRate = new Rate('errors')
const rankingsLatency = new Trend('rankings_latency', true)
const searchLatency = new Trend('search_latency', true)
const traderLatency = new Trend('trader_latency', true)

const BASE_URL = __ENV.BASE_URL || 'https://www.arenafi.org'

export const options = {
  stages: [
    { duration: '10s', target: 10 },  // Ramp up
    { duration: '30s', target: 30 },  // Sustained load
    { duration: '10s', target: 50 },  // Peak
    { duration: '10s', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'],  // 95% of requests under 3s
    errors: ['rate<0.05'],              // Error rate under 5%
    rankings_latency: ['p(95)<2000'],   // Rankings under 2s
    search_latency: ['p(95)<1500'],     // Search under 1.5s
  },
}

const SEARCH_QUERIES = ['binance', 'btc', 'eth', 'hyperliquid', 'trader', '0x', 'gmx']
const WINDOWS = ['90d', '30d', '7d']

export default function () {
  const scenario = Math.random()

  if (scenario < 0.4) {
    // 40% — Rankings API (most popular)
    const window = WINDOWS[Math.floor(Math.random() * WINDOWS.length)]
    const res = http.get(`${BASE_URL}/api/rankings?window=${window}&limit=20`)
    rankingsLatency.add(res.timings.duration)
    const ok = check(res, {
      'rankings: status 200': (r) => r.status === 200,
      'rankings: has traders': (r) => {
        try { return JSON.parse(r.body).data?.traders?.length > 0 } catch { return false }
      },
    })
    errorRate.add(!ok)

  } else if (scenario < 0.65) {
    // 25% — Search API
    const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)]
    const res = http.get(`${BASE_URL}/api/search?q=${query}&limit=5`)
    searchLatency.add(res.timings.duration)
    const ok = check(res, {
      'search: status 200': (r) => r.status === 200,
    })
    errorRate.add(!ok)

  } else if (scenario < 0.85) {
    // 20% — Market data
    const res = http.get(`${BASE_URL}/api/market`)
    check(res, {
      'market: status 200': (r) => r.status === 200,
    })

  } else {
    // 15% — Trader suggestions
    const res = http.get(`${BASE_URL}/api/search/suggestions?q=btc`)
    traderLatency.add(res.timings.duration)
    check(res, {
      'suggestions: status 200': (r) => r.status === 200,
    })
  }

  sleep(Math.random() * 2 + 0.5) // 0.5-2.5s between requests
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration.values['p(95)']
  const errors = data.metrics.errors?.values?.rate || 0
  const reqs = data.metrics.http_reqs.values.count

  console.log(`
╔══════════════════════════════════════╗
║         Arena Load Test Summary       ║
╠══════════════════════════════════════╣
║ Total Requests: ${String(reqs).padStart(20)} ║
║ P95 Latency:    ${String(Math.round(p95) + 'ms').padStart(20)} ║
║ Error Rate:     ${String((errors * 100).toFixed(2) + '%').padStart(20)} ║
╚══════════════════════════════════════╝
  `)

  return {}
}
