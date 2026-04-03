/**
 * 实时市场数据 API
 *
 * 支持两种模式：
 * 1. GET /api/market/realtime - 返回 JSON 快照
 * 2. GET /api/market/realtime?stream=1 - 返回 SSE 流
 *
 * 使用 TradingView WebSocket 获取实时数据。
 * 注意：此路由必须运行在 Node.js 运行时（非 Edge），
 * 因为 TradingView 客户端依赖 `ws` 包。
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getRealtimeSnapshot,
  type RealtimeSnapshot,
} from '@/lib/utils/tradingview-ws'
import { createLogger } from '@/lib/utils/logger'
import { getCorsOrigin } from '@/lib/utils/cors'
import { getOrSetWithLock } from '@/lib/cache'

// 必须使用 Node.js 运行时
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = createLogger('market-realtime-api')

// JSON snapshot 缓存 (2s TTL)
let snapshotCache: { ts: number; data: RealtimeSnapshot } | null = null
const SNAPSHOT_TTL_MS = 2000

export async function GET(request: NextRequest) {

  const { searchParams } = new URL(request.url)
  const isStream = searchParams.get('stream') === '1'
  const origin = request.headers.get('Origin')

  if (isStream) {
    return handleSSE(request, origin)
  }

  return handleSnapshot(origin)
}

async function handleSnapshot(origin: string | null): Promise<NextResponse> {
  const corsOrigin = getCorsOrigin(origin)
  try {
    const now = Date.now()
    if (snapshotCache && now - snapshotCache.ts < SNAPSHOT_TTL_MS) {
      return NextResponse.json(snapshotCache.data, {
        headers: {
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': corsOrigin,
        },
      })
    }

    const snapshot = await getOrSetWithLock(
      'api:market:realtime:snapshot',
      async () => getRealtimeSnapshot(),
      { ttl: 5, lockTtl: 5 }
    )
    snapshotCache = { ts: now, data: snapshot }

    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    logger.error('Realtime snapshot failed', { error: msg })
    return NextResponse.json({ error: 'Failed to fetch market data' }, { status: 500 })
  }
}

function handleSSE(request: NextRequest, origin: string | null): Response {
  const corsOrigin = getCorsOrigin(origin)
  const encoder = new TextEncoder()
  let intervalId: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      // Send initial data
      getRealtimeSnapshot()
        .then((snapshot) => {
          if (closed) return
          const data = `data: ${JSON.stringify(snapshot)}\n\n`
          controller.enqueue(encoder.encode(data))
        })
        .catch((e) => {
          logger.warn('SSE initial snapshot failed', {
            error: e instanceof Error ? e.message : String(e),
          })
        })

      // Send updates every 3 seconds
      intervalId = setInterval(() => {
        if (closed) {
          if (intervalId) clearInterval(intervalId)
          return
        }

        getRealtimeSnapshot()
          .then((snapshot) => {
            if (closed) return
            const data = `data: ${JSON.stringify(snapshot)}\n\n`
            controller.enqueue(encoder.encode(data))
          })
          .catch(() => {
            // Silently skip failed updates to keep stream alive
          })
      }, 3000)

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        closed = true
        if (intervalId) clearInterval(intervalId)
        try {
          controller.close()
        } catch {
          // Intentionally swallowed: stream controller already closed by client disconnect
        }
      })
    },

    cancel() {
      closed = true
      if (intervalId) clearInterval(intervalId)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  })
}
