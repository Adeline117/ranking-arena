/**
 * SSE endpoint for real-time price streaming from Upstash Redis
 * Reads arena:latest hash (populated by VPS bridge) and pushes to clients
 */

import { NextRequest } from 'next/server'
import { getCorsOrigin } from '@/lib/utils/cors'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!

interface PriceData {
  price: number
  changePct24h?: number
  change24h?: number
  volume?: number
  high24h?: number
  low24h?: number
}
async function fetchLatestPrices(): Promise<Record<string, PriceData>> {
  const res = await fetch(`${UPSTASH_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['HGETALL', 'arena:latest']),
    cache: 'no-store',
  })

  if (!res.ok) return {}

  const { result } = await res.json()
  if (!result || !Array.isArray(result)) return {}

  // HGETALL returns flat array: [key, val, key, val, ...]
  const prices: Record<string, PriceData> = {}
  for (let i = 0; i < result.length; i += 2) {
    try {
      prices[result[i]] = JSON.parse(result[i + 1])
    } catch (err) {
      logger.debug(
        'Non-critical error parsing price entry:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  return prices
}

// Per-edge-instance shared memo. Every SSE connection polls every 2s; without
// this each connection independently HGETALLs Upstash → N connections × instance
// = ~N/2 Upstash req/s of identical reads, which saturates the Upstash tier (the
// binding SPOF) under an airdrop spike. Memoizing for ~1.8s collapses all
// concurrent connections in one edge instance into a single upstream read per
// cycle, with in-flight dedup so a thundering herd shares one fetch. The 2s
// live-push cadence to clients is unchanged.
const PRICE_MEMO_MS = 1800
let priceMemo: { ts: number; data: Record<string, PriceData> } | null = null
let priceInflight: Promise<Record<string, PriceData>> | null = null

async function getLatestPrices(): Promise<Record<string, PriceData>> {
  const now = Date.now()
  if (priceMemo && now - priceMemo.ts < PRICE_MEMO_MS) return priceMemo.data
  if (priceInflight) return priceInflight
  priceInflight = fetchLatestPrices()
    .then((data) => {
      priceMemo = { ts: Date.now(), data }
      return data
    })
    .finally(() => {
      priceInflight = null
    })
  return priceInflight
}

export async function GET(request: NextRequest) {
  // Rate limit SSE connections to prevent connection pool exhaustion
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.realtime)
  if (rateLimitResp) return rateLimitResp

  const origin = request.headers.get('Origin')
  const encoder = new TextEncoder()
  let closed = false
  let intervalId: ReturnType<typeof setInterval> | null = null
  let heartbeatId: ReturnType<typeof setInterval> | null = null

  const cleanup = () => {
    closed = true
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
    if (heartbeatId) {
      clearInterval(heartbeatId)
      heartbeatId = null
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      const push = async () => {
        if (closed) return
        try {
          const prices = await getLatestPrices()
          if (Object.keys(prices).length > 0) {
            const data = `data: ${JSON.stringify(prices)}\n\n`
            controller.enqueue(encoder.encode(data))
          }
        } catch (err) {
          logger.debug(
            'Non-critical error fetching prices:',
            err instanceof Error ? err.message : String(err)
          )
        }
      }

      // Initial push
      push()
      // Poll Upstash every 2s
      intervalId = setInterval(push, 2000)

      // Keepalive comment every 15s to prevent proxy/CDN timeout
      heartbeatId = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch (err) {
          logger.debug(
            'Non-critical error sending keepalive:',
            err instanceof Error ? err.message : String(err)
          )
          cleanup()
        }
      }, 15000)
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': getCorsOrigin(origin),
    },
  })
}
