/**
 * V1 heartbeat ingress boundary.
 *
 * GET heartbeat-history availability and POST writes are independently
 * authenticated, source-only holds while their respective V1 publication
 * evidence is incomplete.
 */

import type { NextRequest } from 'next/server'
import {
  v1CronExecutionGate,
  v1CronExecutionUnavailableResponse,
} from '@/lib/cron/v1-execution-publication'
import {
  v1HeartbeatHistoryGate,
  v1HeartbeatHistoryUnavailableResponse,
} from '@/lib/monitoring/v1-heartbeat-history-publication'

export const dynamic = 'force-dynamic'

/** POST /api/health/heartbeat — V1 legacy heartbeat write hold. */
export function POST(request: NextRequest) {
  return v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()
}

/** GET /api/health/heartbeat — V1 heartbeat-history availability hold. */
export function GET(request: NextRequest) {
  return v1HeartbeatHistoryGate(request) ?? v1HeartbeatHistoryUnavailableResponse()
}
