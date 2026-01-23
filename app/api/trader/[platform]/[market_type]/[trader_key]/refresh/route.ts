/**
 * POST /api/trader/:platform/:market_type/:trader_key/refresh
 *
 * Enqueues a refresh job for the specified trader.
 * Does NOT synchronously fetch data - only creates a job.
 * Returns immediately with job status.
 *
 * Response:
 *   - job_id: UUID of the created job
 *   - status: 'queued'
 *   - message: Description
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

interface RouteParams {
  params: Promise<{
    platform: string;
    market_type: string;
    trader_key: string;
  }>;
}

export async function POST(_request: Request, { params }: RouteParams) {
  const { platform, market_type, trader_key } = await params;

  try {
    if (!SUPABASE_SERVICE_KEY) {
      return NextResponse.json(
        { error: 'Service configuration error' },
        { status: 500 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Check if there's already a pending/running job for this trader
    const { data: existingJob } = await supabase
      .from('refresh_jobs')
      .select('id, status, created_at')
      .eq('platform', platform)
      .eq('market_type', market_type)
      .eq('trader_key', trader_key)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existingJob) {
      return NextResponse.json({
        job_id: existingJob.id,
        status: 'already_queued',
        message: `Refresh already in progress (status: ${existingJob.status})`,
      });
    }

    // Check platform health / circuit breaker
    const { data: health } = await supabase
      .from('platform_health')
      .select('status, circuit_closes_at')
      .eq('platform', platform)
      .single();

    if (health?.status === 'circuit_open') {
      const closesAt = health.circuit_closes_at
        ? new Date(health.circuit_closes_at).toISOString()
        : 'unknown';

      return NextResponse.json({
        job_id: null,
        status: 'circuit_open',
        message: `Platform ${platform} is temporarily unavailable. Circuit closes at ${closesAt}`,
      }, { status: 503 });
    }

    // Create snapshot + profile jobs (user-triggered = high priority)
    const jobs = [
      {
        job_type: 'SNAPSHOT',
        platform,
        market_type,
        trader_key,
        priority: 5, // High priority for user-triggered
        status: 'pending',
        next_run_at: new Date().toISOString(),
      },
      {
        job_type: 'PROFILE',
        platform,
        market_type,
        trader_key,
        priority: 5,
        status: 'pending',
        next_run_at: new Date().toISOString(),
      },
    ];

    const { data: createdJobs, error } = await supabase
      .from('refresh_jobs')
      .insert(jobs)
      .select('id');

    if (error) {
      console.error('[refresh] Job creation error:', error.message);
      return NextResponse.json(
        { error: 'Failed to create refresh job', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      job_id: createdJobs?.[0]?.id || null,
      status: 'queued',
      message: `Refresh queued for ${platform}/${market_type}/${trader_key}. Data will update within minutes.`,
      jobs_created: createdJobs?.length || 0,
    });
  } catch (error) {
    console.error('[refresh] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
