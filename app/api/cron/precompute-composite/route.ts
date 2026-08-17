/**
 * Retired composite-ranking cache command.
 *
 * V1 has no approved execution witness for a direct authenticated caller.
 * Keep this endpoint authentication-first and unavailable before it can read
 * request parameters, acquire a lock, query any store, or write Redis.
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
