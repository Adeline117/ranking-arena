import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { queryOne } from '@/lib/db'
import { getAuthUser } from '@/lib/supabase/server'
import { getHandleShapeError, isReservedHandle } from '@/lib/identity/handle-policy'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:profile-handle-availability')
const requestSchema = z.object({ handle: z.string() }).strict()

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse
  } catch (error) {
    logger.error('Handle availability rate-limit check failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  let user: Awaited<ReturnType<typeof getAuthUser>>
  try {
    user = await getAuthUser(request)
  } catch (error) {
    logger.error('Handle availability authentication failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsedBody = requestSchema.safeParse(rawBody)
  if (
    !parsedBody.success ||
    getHandleShapeError(parsedBody.data.handle) !== null ||
    isReservedHandle(parsedBody.data.handle)
  ) {
    return NextResponse.json({ error: 'Invalid handle' }, { status: 400 })
  }

  try {
    // Equality keeps the availability check identical to the database's
    // case-insensitive unique index without introducing pattern semantics.
    const result = await queryOne<{ taken: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM public.user_profiles
          WHERE lower(handle) = lower($1)
            AND id <> $2::uuid
       ) AS taken`,
      [parsedBody.data.handle, user.id]
    )

    if (!result || typeof result.taken !== 'boolean') {
      logger.error('Handle availability query returned no result', { userId: user.id })
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
    }

    return NextResponse.json({ available: !result.taken })
  } catch (error) {
    logger.error('Handle availability query failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}
