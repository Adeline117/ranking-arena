/**
 * Dependencies Health API
 * GET /api/health/dependencies
 *
 * Checks: Supabase (SELECT 1), Redis (PING), each exchange API (HEAD), TradingView CDN.
 * Returns status + latency per dependency.
 */

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface DependencyStatus {
  status: 'up' | 'down' | 'degraded' | 'skip'
  latencyMs: number
  message?: string
}

interface DependenciesResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  dependencies: Record<string, DependencyStatus>
}

async function checkWithTimeout(
  name: string,
  fn: () => Promise<DependencyStatus>,
  timeoutMs = 10_000
): Promise<[string, DependencyStatus]> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<DependencyStatus>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      ),
    ])
    return [name, result]
  } catch (err) {
    return [
      name,
      {
        status: 'down',
        latencyMs: timeoutMs,
        message: err instanceof Error ? err.message : 'Unknown error',
      },
    ]
  }
}

async function checkSupabase(): Promise<DependencyStatus> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return { status: 'skip', latencyMs: 0, message: 'Not configured' }

  const start = Date.now()
  const res = await fetch(`${url}/rest/v1/`, {
    method: 'HEAD',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  })
  const latencyMs = Date.now() - start
  return {
    status: res.ok ? 'up' : 'down',
    latencyMs,
    message: res.ok ? undefined : `HTTP ${res.status}`,
  }
}

async function checkRedis(): Promise<DependencyStatus> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return { status: 'skip', latencyMs: 0, message: 'Not configured' }

  const start = Date.now()
  const res = await fetch(`${url}/ping`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const latencyMs = Date.now() - start
  const body = await res.json().catch(() => null)
  const pong = body?.result === 'PONG'
  return {
    status: pong ? 'up' : 'down',
    latencyMs,
    message: pong ? undefined : `Response: ${JSON.stringify(body)}`,
  }
}

async function checkUrl(name: string, url: string): Promise<DependencyStatus> {
  const start = Date.now()
  const res = await fetch(url, {
    method: 'HEAD',
    signal: AbortSignal.timeout(8000),
  })
  const latencyMs = Date.now() - start
  return {
    status: res.ok || res.status === 403 ? 'up' : 'degraded',
    latencyMs,
    message: res.ok ? undefined : `HTTP ${res.status}`,
  }
}

const EXCHANGE_ENDPOINTS: Record<string, string> = {
  binance: 'https://fapi.binance.com/fapi/v1/ping',
  bybit: 'https://api.bybit.com/v5/market/time',
  okx: 'https://www.okx.com/api/v5/public/time',
  bitget: 'https://api.bitget.com/api/v2/public/time',
  hyperliquid: 'https://api.hyperliquid.xyz/info',
  mexc: 'https://api.mexc.com/api/v3/ping',
  kucoin: 'https://api.kucoin.com/api/v1/timestamp',
  gateio: 'https://api.gateio.ws/api/v4/spot/currencies/BTC',
  htx: 'https://api.huobi.pro/v1/common/timestamp',
  coinex: 'https://api.coinex.com/v2/ping',
}

export async function GET() {
  const checks = await Promise.all([
    checkWithTimeout('supabase', checkSupabase),
    checkWithTimeout('redis', checkRedis),
    checkWithTimeout('tradingview_cdn', () =>
      checkUrl('tradingview_cdn', 'https://s3.tradingview.com/tv.js')
    ),
    ...Object.entries(EXCHANGE_ENDPOINTS).map(([name, url]) =>
      checkWithTimeout(name, () => checkUrl(name, url))
    ),
  ])

  const dependencies: Record<string, DependencyStatus> = {}
  for (const [name, status] of checks) {
    dependencies[name] = status
  }

  // Calculate overall status
  const statuses = Object.values(dependencies)
  const coreDown = dependencies.supabase?.status === 'down'
  const anyDown = statuses.some((s) => s.status === 'down')

  const status: DependenciesResponse['status'] = coreDown
    ? 'unhealthy'
    : anyDown
      ? 'degraded'
      : 'healthy'

  const response: DependenciesResponse = {
    status,
    timestamp: new Date().toISOString(),
    dependencies,
  }

  return NextResponse.json(response, {
    status: status === 'unhealthy' ? 503 : 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}
