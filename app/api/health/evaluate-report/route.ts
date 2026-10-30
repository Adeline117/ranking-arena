/**
 * Retired code-quality evaluator ingress.
 *
 * V1 keeps this endpoint authentication-first and unavailable.
 */

import {
  v1CronExecutionGate,
  v1CronExecutionUnavailableResponse,
} from '@/lib/cron/v1-execution-publication'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  return v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()
}
