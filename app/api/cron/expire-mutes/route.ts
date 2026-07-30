/**
 * Expire Mutes & Temp Bans Cron
 * GET /api/cron/expire-mutes
 *
 * Runs every six hours. Clears expired group mutes and temporary account bans through
 * one database transaction. Active/permanent sanctions always fail closed.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { withCron } from '@/lib/api/with-cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

interface ExpiredSanctionCleanupResult {
  group_mutes_cleared: number
  temp_bans_cleared: number
  temp_bans_preserved: number
}

const CLEANUP_LIMIT = 500
const CLEANUP_WORK_BUDGET_MS = 20_000

function parseCleanupResult(value: unknown): ExpiredSanctionCleanupResult {
  if (!value || typeof value !== 'object') {
    throw new Error('Expired-sanction cleanup returned an invalid acknowledgement')
  }
  const candidate = value as Record<string, unknown>
  const fields = [
    candidate.group_mutes_cleared,
    candidate.temp_bans_cleared,
    candidate.temp_bans_preserved,
  ]
  if (
    fields.some(
      (field) => !Number.isSafeInteger(field) || Number(field) < 0 || Number(field) > CLEANUP_LIMIT
    )
  ) {
    throw new Error('Expired-sanction cleanup returned invalid counters')
  }
  return candidate as unknown as ExpiredSanctionCleanupResult
}

export const GET = withCron(
  'expire-mutes',
  async (_request: NextRequest) => {
    const supabase = getSupabaseAdmin()
    const workSignal = AbortSignal.timeout(CLEANUP_WORK_BUDGET_MS)
    const query = Reflect.apply(supabase.rpc, supabase, [
      'expire_mutes_and_temporary_bans_atomic',
      { p_limit: CLEANUP_LIMIT },
    ]) as {
      abortSignal(signal: AbortSignal): PromiseLike<{
        data: unknown
        error: { message?: string } | null
      }>
    }
    const { data, error } = await query.abortSignal(workSignal)

    if (error) {
      throw new Error(
        `Expired-sanction cleanup failed: ${error.message ?? 'unknown database error'}`
      )
    }
    workSignal.throwIfAborted()
    const result = parseCleanupResult(data)
    return {
      count: result.group_mutes_cleared + result.temp_bans_cleared,
      ...result,
    }
  },
  { safetyTimeoutMs: 25_000 }
)
