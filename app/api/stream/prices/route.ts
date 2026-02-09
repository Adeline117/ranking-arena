/**
 * SSE endpoint for real-time price streaming from Upstash Redis
 * Reads arena:latest hash (populated by VPS bridge) and pushes to clients
 */

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!

async function getLatestPrices(): Promise<Record<string, any>> {
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
  const prices: Record<string, any> = {}
  for (let i = 0; i < result.length; i += 2) {
    try {
      prices[result[i]] = JSON.parse(result[i + 1])
    } catch {}
  }
  return prices
}

export async function GET() {
  const encoder = new TextEncoder()
  let closed = false
  let intervalId: ReturnType<typeof setInterval> | null = null
  let heartbeatId: ReturnType<typeof setInterval> | null = null

  const cleanup = () => {
    closed = true
    if (intervalId) { clearInterval(intervalId); intervalId = null }
    if (heartbeatId) { clearInterval(heartbeatId); heartbeatId = null }
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
          // skip errors, keep streaming
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
        } catch {
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
      'Access-Control-Allow-Origin': '*',
    },
  })
}
