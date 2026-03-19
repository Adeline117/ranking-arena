/**
 * SSE 实时市场数据端点
 *
 * 使用 Server-Sent Events 将聚合的交易所数据推送到客户端
 * 路径: GET /api/ws/market
 *
 * 查询参数:
 *   symbols - 逗号分隔的交易对, 默认 BTC-USDT,ETH-USDT,SOL-USDT
 *   exchanges - 逗号分隔的交易所, 默认 binance,bybit,okx
 */

import { NextRequest } from 'next/server'
import { FeedManager } from '@/lib/ws/feed-manager'
import type { ExchangeId } from '@/lib/ws/exchange-feeds'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_EXCHANGES = new Set<ExchangeId>(['binance', 'bybit', 'okx'])

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const symbolsParam = searchParams.get('symbols') || 'BTC-USDT,ETH-USDT,SOL-USDT'
  const exchangesParam = searchParams.get('exchanges') || 'binance,bybit,okx'

  const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  const exchanges = exchangesParam
    .split(',')
    .map(e => e.trim().toLowerCase() as ExchangeId)
    .filter(e => VALID_EXCHANGES.has(e))

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null
  // Close the SSE stream after 55 seconds to stay within Vercel's 60s
  // serverless function limit and allow the client to reconnect cleanly.
  // The client (useMarketFeed) will automatically reconnect on close.
  let maxAgeTimer: ReturnType<typeof setTimeout> | null = null
  const MAX_CONNECTION_AGE_MS = 55_000

  const stream = new ReadableStream({
    start(controller) {
      const manager = FeedManager.getInstance({ symbols, exchanges })

      // 确保已启动
      manager.start()

      // 发送初始快照
      const snapshot = manager.getSnapshot()
      const initData = {
        type: 'snapshot',
        trades: snapshot.recentTrades.slice(0, 50),
        connectionStatus: snapshot.connectionStatus,
        timestamp: Date.now(),
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(initData)}\n\n`))

      // 订阅实时更新
      unsubscribe = manager.subscribe((event: string, data) => {
        try {
          const msg = { type: event, data, timestamp: Date.now() }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`))
        } catch {
          // Intentionally swallowed: client disconnected, enqueue fails when stream is closed
        }
      })

      // 每 30 秒发送心跳保持连接
      keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          // Intentionally swallowed: keepalive write fails when client disconnects, cleanup handled by cancel()
        }
      }, 30000)

      // Close stream after max age to stay within Vercel serverless limits.
      // Client (useMarketFeed) will reconnect automatically via its onerror handler.
      maxAgeTimer = setTimeout(() => {
        try {
          controller.enqueue(encoder.encode('data: {"type":"reconnect"}\n\n'))
          controller.close()
        } catch {
          // Intentionally swallowed: stream already closed
        }
      }, MAX_CONNECTION_AGE_MS)
    },
    cancel() {
      if (unsubscribe) unsubscribe()
      if (keepAliveTimer) clearInterval(keepAliveTimer)
      if (maxAgeTimer) clearTimeout(maxAgeTimer)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
