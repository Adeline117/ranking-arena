/**
 * POST /api/trader/:platform/:trader_key/refresh
 * Creates a refresh job for the given trader.
 * De-duplicates: if a pending/running job already exists, returns it instead.
 *
 * Body (optional):
 *   job_type: 'full_refresh' | 'profile_only' | 'snapshot_only' | 'timeseries_only'
 *   priority: 1-9 (default: 1 for user-triggered)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets, requireAuth } from '@/lib/api'
import type {
  JobType,
  RefreshResponse,
  RefreshJobSummary,
} from '@/lib/types/trading-platform'

export const dynamic = 'force-dynamic'

const VALID_PLATFORMS: string[] = [
  'binance_futures', 'binance_spot', 'bybit', 'bitget_futures',
  'bitget_spot', 'mexc', 'okx_web3', 'kucoin', 'coinex', 'gmx',
]

const VALID_JOB_TYPES: JobType[] = [
  'full_refresh', 'profile_only', 'snapshot_only', 'timeseries_only',
]

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string; trader_key: string }> }
) {
  // Rate limit: prevent abuse of refresh endpoint (writes to DB + triggers exchange API calls)
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  // Authentication required: unauthenticated users must not be able to trigger background jobs
  try {
    await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const { platform, trader_key } = await params

  // Validate platform
  if (!VALID_PLATFORMS.includes(platform)) {
    return NextResponse.json(
      { error: `Invalid platform: ${platform}` },
      { status: 400 }
    )
  }

  if (!trader_key) {
    return NextResponse.json(
      { error: 'trader_key is required' },
      { status: 400 }
    )
  }

  // Parse body
  let jobType: JobType = 'full_refresh'
  let priority = 1  // User-triggered = highest priority

  try {
    const body = await request.json().catch(() => ({}))
    if (body.job_type && VALID_JOB_TYPES.includes(body.job_type)) {
      jobType = body.job_type
    }
    if (body.priority && typeof body.priority === 'number' && body.priority >= 1 && body.priority <= 9) {
      priority = body.priority
    }
  } catch {
    // Empty body is fine, use defaults
  }

  const supabase = getSupabaseAdmin()

  // Check for existing active job (deduplication)
  const { data: existingJob } = await supabase
    .from('refresh_jobs')
    .select('id, status, attempts, last_error, created_at, updated_at')
    .eq('platform', platform)
    .eq('trader_key', trader_key)
    .eq('job_type', jobType)
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingJob) {
    // Return existing job instead of creating duplicate
    const summary: RefreshJobSummary = {
      id: existingJob.id,
      status: existingJob.status,
      attempts: existingJob.attempts,
      last_error: existingJob.last_error,
      created_at: existingJob.created_at,
      updated_at: existingJob.updated_at,
    }
    const response: RefreshResponse = { job: summary, created: false }
    return NextResponse.json(response)
  }

  // Create new refresh job
  const { data: newJob, error } = await supabase
    .from('refresh_jobs')
    .insert({
      job_type: jobType,
      platform,
      trader_key,
      priority,
      status: 'pending',
      attempts: 0,
      max_attempts: 3,
      next_run_at: new Date().toISOString(),
    })
    .select('id, status, attempts, last_error, created_at, updated_at')
    .single()

  if (error) {
    // Handle unique constraint violation (race condition)
    if (error.code === '23505') {
      // Another request created the job in parallel, fetch it
      const { data: raceJob } = await supabase
        .from('refresh_jobs')
        .select('id, status, attempts, last_error, created_at, updated_at')
        .eq('platform', platform)
        .eq('trader_key', trader_key)
        .eq('job_type', jobType)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (raceJob) {
        const summary: RefreshJobSummary = {
          id: raceJob.id,
          status: raceJob.status,
          attempts: raceJob.attempts,
          last_error: raceJob.last_error,
          created_at: raceJob.created_at,
          updated_at: raceJob.updated_at,
        }
        return NextResponse.json({ job: summary, created: false } as RefreshResponse)
      }
    }

    return NextResponse.json(
      { error: 'Failed to create refresh job', details: error.message },
      { status: 500 }
    )
  }

  const summary: RefreshJobSummary = {
    id: newJob.id,
    status: newJob.status,
    attempts: newJob.attempts,
    last_error: newJob.last_error,
    created_at: newJob.created_at,
    updated_at: newJob.updated_at,
  }
  const response: RefreshResponse = { job: summary, created: true }
  return NextResponse.json(response, { status: 201 })
}
