import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { getSharedRedis } from '@/lib/cache/redis-client'
import {
  evaluateWorkerReleaseReadiness,
  WORKER_FAILOVER_FLAG_KEY,
} from '@/lib/ingest/worker-release-readiness'

export const dynamic = 'force-dynamic'

const ROSTER_KEY = 'arena:worker:roster'
const COMMIT_SHA = /^[0-9a-f]{40}$/

/** Authenticated, read-only release gate over the live ingest worker roster. */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const expectedSha = request.nextUrl.searchParams.get('expected_sha') ?? ''
  if (!COMMIT_SHA.test(expectedSha)) {
    return NextResponse.json(
      { error: 'expected_sha must be a full lowercase commit SHA' },
      { status: 400 }
    )
  }

  const redis = await getSharedRedis()
  if (!redis) {
    return NextResponse.json({ error: 'worker roster unavailable' }, { status: 503 })
  }

  try {
    const [roster, failoverFlag] = await Promise.all([
      redis.hgetall(ROSTER_KEY) as Promise<Record<string, unknown> | null>,
      redis.get(WORKER_FAILOVER_FLAG_KEY),
    ])
    return NextResponse.json(
      evaluateWorkerReleaseReadiness(roster, expectedSha, Date.now(), failoverFlag),
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  } catch {
    return NextResponse.json({ error: 'worker roster read failed' }, { status: 503 })
  }
}
