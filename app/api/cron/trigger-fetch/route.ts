/**
 * Cron 触发端点
 * 用于触发外部 Worker 服务执行数据抓取
 * 
 * 这个端点只负责触发，实际的抓取工作由独立的 Worker 服务完成
 */

import { NextResponse } from 'next/server'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // 开发环境允许无密钥访问
  if (!cronSecret && process.env.NODE_ENV === 'development') {
    return true
  }

  if (!cronSecret) return false
  return authHeader === `Bearer ${cronSecret}`
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Cron trigger endpoint. Use POST to trigger fetch.',
    timestamp: new Date().toISOString(),
  })
}

export async function POST(req: Request) {
  // 验证请求
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workerUrl = process.env.WORKER_URL

  if (!workerUrl) {
    // 如果没有配置 Worker URL，返回提示
    return NextResponse.json({
      ok: false,
      message: 'Worker URL not configured. Please deploy the worker service and set WORKER_URL.',
      timestamp: new Date().toISOString(),
    }, { status: 503 })
  }

  try {
    // 触发外部 Worker 服务
    const response = await fetch(`${workerUrl}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WORKER_SECRET || ''}`,
      },
      body: JSON.stringify({
        sources: ['binance_spot', 'binance', 'bybit', 'bitget'],
        timeRanges: ['7D', '30D', '90D'],
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      return NextResponse.json({
        ok: false,
        error: `Worker responded with ${response.status}: ${error}`,
        timestamp: new Date().toISOString(),
      }, { status: 502 })
    }

    const result = await response.json()

    return NextResponse.json({
      ok: true,
      message: 'Scrape triggered successfully',
      workerResponse: result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    return NextResponse.json({
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}
