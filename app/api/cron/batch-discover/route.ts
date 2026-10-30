/**
 * Retired legacy refresh-job discovery command.
 *
 * The prior command seeded `refresh_jobs` and invoked a lock-release RPC.
 * V1 keeps the endpoint authentication-first and unavailable before it can
 * initialize a pipeline log, query a store, or enqueue source acquisition.
 */

import {
  v1CronExecutionGate,
  v1CronExecutionUnavailableResponse,
} from '@/lib/cron/v1-execution-publication'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

export function GET(request: Request) {
  return v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()
}
