/**
 * Ranking snapshot creation.
 *
 * The HTTP boundary admits one exact actor/request intent. PostgreSQL owns the
 * parent row, every trader row, publication and durable replay receipt in one
 * transaction.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import {
  AtomicRankingSnapshotCreateAckSchema,
  RankingSnapshotCreateRequestSchema,
  acknowledgementMatchesSnapshotRequest,
  readBoundedRankingSnapshotJson,
} from '@/lib/ranking-snapshots/create-contract'

export const runtime = 'nodejs'

const logger = createLogger('ranking-snapshot')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AUTHORITY_UNAVAILABLE_CODES = new Set([
  'PGRST202',
  'PGRST205',
  '42883',
  '42P01',
  '42703',
  '55P03',
  '57014',
])

function privateNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('CDN-Cache-Control', 'no-store')
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Vary', 'Authorization, Cookie')
  return response
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status })
}

function isAuthorityUnavailable(error: { code?: string; message?: string }): boolean {
  return (
    AUTHORITY_UNAVAILABLE_CODES.has(error.code ?? '') ||
    Boolean(error.message?.includes('Could not find the function')) ||
    Boolean(error.message?.includes('schema cache'))
  )
}

export async function GET(): Promise<Response> {
  return privateNoStore(jsonError('Use POST to create a ranking snapshot', 405))
}

async function createRankingSnapshot(request: NextRequest): Promise<Response> {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  const { user, error: authError } = await extractUserFromRequest(request)
  if (authError || !user) return jsonError('Authentication required', 401)
  if (!UUID_RE.test(user.id)) {
    logger.error('Authenticated snapshot actor is malformed')
    return jsonError('Snapshot creation failed', 500)
  }
  const actorId = user.id.toLowerCase()

  const decoded = await readBoundedRankingSnapshotJson(request)
  if (!decoded.ok && decoded.reason === 'too_large') {
    return jsonError('Request body too large', 413)
  }
  if (!decoded.ok) return jsonError('Invalid JSON body', 400)

  const parsed = RankingSnapshotCreateRequestSchema.safeParse(decoded.value)
  if (!parsed.success) return jsonError('Invalid ranking snapshot request', 400)
  const input = parsed.data

  try {
    const { data, error } = await getSupabaseAdmin()
      .rpc('create_ranking_snapshot_atomic', {
        p_actor_id: actorId,
        p_request_id: input.request_id,
        p_exchange: input.exchange,
        p_time_range: input.time_range,
        p_traders: input.traders,
      })
      .abortSignal(AbortSignal.timeout(15_000))

    if (error) {
      logger.error('Atomic snapshot create failed', { code: error.code })
      return isAuthorityUnavailable(error)
        ? jsonError('Snapshot creation is temporarily unavailable', 503)
        : jsonError('Snapshot creation failed', 500)
    }

    if (
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Object.keys(data).length === 1
    ) {
      if (data.status === 'invalid') return jsonError('Invalid ranking snapshot request', 400)
      if (data.status === 'account_inactive') {
        return jsonError('No permission to create this snapshot', 403)
      }
      if (data.status === 'request_conflict') {
        return jsonError('Request ID was already used for another snapshot', 409)
      }
    }

    const acknowledgement = AtomicRankingSnapshotCreateAckSchema.safeParse(data)
    if (
      !acknowledgement.success ||
      !acknowledgementMatchesSnapshotRequest(acknowledgement.data, actorId, input)
    ) {
      logger.error('Atomic snapshot create returned an invalid acknowledgement', {
        actorId,
        requestId: input.request_id,
      })
      return jsonError('Snapshot creation failed', 500)
    }

    const receipt = acknowledgement.data
    return NextResponse.json(
      {
        operation: receipt.operation,
        request_id: receipt.request_id,
        actor_id: receipt.actor_id,
        status: receipt.status,
        applied: receipt.applied,
        snapshot: {
          id: receipt.snapshot.id,
          share_token: receipt.snapshot.share_token,
          url: `/s/${receipt.snapshot.share_token}`,
          expires_at: receipt.snapshot.expires_at,
          total_traders: receipt.snapshot.total_traders,
          top_trader_handle: receipt.snapshot.top_trader_handle,
          top_trader_roi: receipt.snapshot.top_trader_roi,
        },
      },
      { status: receipt.applied ? 201 : 200 }
    )
  } catch (error) {
    logger.error('Atomic snapshot create threw', {
      actorId,
      error: error instanceof Error ? error.message : String(error),
    })
    return jsonError('Snapshot creation is temporarily unavailable', 503)
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return privateNoStore(await createRankingSnapshot(request))
}
