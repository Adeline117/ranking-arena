import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:profile-attribution')
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

const attributionValueSchema = z
  .string()
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Control characters are not allowed')
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(200))

const attributionBodySchema = z
  .object({
    utmSource: attributionValueSchema.optional(),
    utmMedium: attributionValueSchema.optional(),
    utmCampaign: attributionValueSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.utmSource !== undefined ||
      value.utmMedium !== undefined ||
      value.utmCampaign !== undefined,
    'At least one attribution field is required'
  )

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse
  } catch (error) {
    logger.error('Attribution rate-limit check failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }

  let user: Awaited<ReturnType<typeof getAuthUser>>
  try {
    user = await getAuthUser(request)
  } catch (error) {
    logger.error('Attribution authentication failed', {
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

  const parsedBody = attributionBodySchema.safeParse(rawBody)
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid attribution data' }, { status: 400 })
  }

  const updates: {
    utm_source?: string
    utm_medium?: string
    utm_campaign?: string
  } = {}
  if (parsedBody.data.utmSource !== undefined) {
    updates.utm_source = parsedBody.data.utmSource
  }
  if (parsedBody.data.utmMedium !== undefined) {
    updates.utm_medium = parsedBody.data.utmMedium
  }
  if (parsedBody.data.utmCampaign !== undefined) {
    updates.utm_campaign = parsedBody.data.utmCampaign
  }

  try {
    // Admin access is intentionally initialized only after authentication and
    // validation. The caller can never choose the target profile id.
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from('user_profiles')
      .update(updates)
      .eq('id', user.id)
      .is('utm_source', null)
      .is('utm_medium', null)
      .is('utm_campaign', null)
      .select('id')
      .maybeSingle()

    if (error) {
      logger.error('Attribution update failed', {
        userId: user.id,
        code: error.code,
      })
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
    }

    if (data) {
      return NextResponse.json({ success: true })
    }

    // A zero-row conditional update is expected when another request won the
    // first-touch race or the profile was attributed earlier. Distinguish that
    // idempotent state from a missing profile or database failure without
    // exposing any attribution values.
    const { data: existingProfile, error: existingProfileError } = await supabase
      .from('user_profiles')
      .select('id, utm_source, utm_medium, utm_campaign')
      .eq('id', user.id)
      .maybeSingle()

    if (existingProfileError || !existingProfile) {
      logger.error('Attribution state lookup failed', {
        userId: user.id,
        code: existingProfileError?.code,
      })
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
    }

    if (
      existingProfile.utm_source !== null ||
      existingProfile.utm_medium !== null ||
      existingProfile.utm_campaign !== null
    ) {
      return NextResponse.json({ success: true, status: 'already_attributed' })
    }

    logger.error('Attribution conditional update affected no row', { userId: user.id })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  } catch (error) {
    logger.error('Attribution update threw', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  }
}
