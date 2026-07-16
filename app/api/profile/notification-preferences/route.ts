import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import {
  EMAIL_DIGEST_VALUES,
  NOTIFICATION_PREFERENCE_FIELDS,
} from '@/lib/profile/notification-preferences'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:profile-notification-preferences')
const requestSchema = z.union([
  z
    .object({
      field: z.enum(NOTIFICATION_PREFERENCE_FIELDS),
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      field: z.literal('email_digest'),
      value: z.enum(EMAIL_DIGEST_VALUES),
    })
    .strict(),
])

export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse
  } catch (error) {
    logger.error('Notification preference rate-limit check failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  let user: Awaited<ReturnType<typeof getAuthUser>>
  try {
    user = await getAuthUser(request)
  } catch (error) {
    logger.error('Notification preference authentication failed', {
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
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid profile preference' }, { status: 400 })
  }

  try {
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from('user_profiles')
      .update({ [parsedBody.data.field]: parsedBody.data.value })
      .eq('id', user.id)
      .select('id')
      .maybeSingle()

    if (error || !data) {
      logger.error('Notification preference update failed', {
        userId: user.id,
        field: parsedBody.data.field,
        code: error?.code,
      })
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error('Notification preference update threw', {
      userId: user.id,
      field: parsedBody.data.field,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}
