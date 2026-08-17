/**
 * Retired post-deploy evaluator hook.
 *
 * V1 release automation is source-disabled. Keep both compatibility methods
 * authentication-first and unavailable before they can inspect deployment
 * parameters, evaluate the pipeline, write state, or send an alert.
 */

import {
  v1CronExecutionGate,
  v1CronExecutionUnavailableResponse,
} from '@/lib/cron/v1-execution-publication'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

function retiredPostDeployHook(request: Request) {
  return v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()
}

export const GET = retiredPostDeployHook
export const POST = retiredPostDeployHook
