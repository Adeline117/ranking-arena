/**
 * Health check endpoint for monitoring (callable, not cron-scheduled).
 *
 * NOT in vercel.json crons — invoked by external uptime monitors (e.g., OpenClaw).
 * Returns 200 OK with basic system status.
 * No authentication required - public health check.
 */

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

export async function GET(_request: NextRequest) {
  const timestamp = new Date().toISOString()
  
  return NextResponse.json({
    status: 'ok',
    timestamp,
    service: 'ranking-arena',
    uptime: process.uptime(),
  }, {
    status: 200,
  })
}
