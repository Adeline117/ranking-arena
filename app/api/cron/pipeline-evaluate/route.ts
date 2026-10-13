/**
 * Retired ranking-pipeline evaluator command.
 *
 * It is part of the compute → evaluate → cache chain and remains unavailable
 * during V1 verification. Authenticate before returning a fixed tombstone,
 * without reading query parameters, opening a pipeline log, evaluating data,
 * writing state, or sending an alert.
 */

import {
  v1CronExecutionGate,
  v1CronExecutionUnavailableResponse,
} from '@/lib/cron/v1-execution-publication'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

export function GET(request: Request) {
  return v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()
}
