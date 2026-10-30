/**
 * Retired production smoke-test command.
 *
 * V1 keeps this direct cron ingress authentication-first and unavailable.
 */

import {
  v1CronExecutionGate,
  v1CronExecutionUnavailableResponse,
} from '@/lib/cron/v1-execution-publication'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export function GET(request: Request) {
  return v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()
}
