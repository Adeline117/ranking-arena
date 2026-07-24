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
const RELEASE_ID = /^[0-9a-f]{64}$/

/** Authenticated, read-only release gate over the live ingest worker roster. */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Bind the gate to identities injected into this exact immutable candidate.
  // Caller-supplied expected values would let a credential holder ask whether
  // an older fleet is ready; the deploy gate must never promote on that basis.
  const expectedSha = process.env.ARENA_RELEASE_SHA?.trim() ?? ''
  const expectedReleaseId = process.env.ARENA_WORKER_RELEASE_ID?.trim() ?? ''
  if (!COMMIT_SHA.test(expectedSha) || !RELEASE_ID.test(expectedReleaseId)) {
    return NextResponse.json(
      { error: 'candidate worker release identity unavailable' },
      { status: 503 }
    )
  }

  try {
    const redis = await getSharedRedis()
    if (!redis) {
      return NextResponse.json({ error: 'worker roster unavailable' }, { status: 503 })
    }
    const [roster, failoverFlag] = await Promise.all([
      redis.hgetall(ROSTER_KEY) as Promise<Record<string, unknown> | null>,
      redis.get(WORKER_FAILOVER_FLAG_KEY),
    ])
    return NextResponse.json(
      evaluateWorkerReleaseReadiness(
        roster,
        expectedSha,
        expectedReleaseId,
        Date.now(),
        failoverFlag
      ),
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  } catch {
    return NextResponse.json({ error: 'worker roster read failed' }, { status: 503 })
  }
}
