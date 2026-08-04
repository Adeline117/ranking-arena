/**
 * 2FA Disable API
 * POST: Disable 2FA with password confirmation
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { twoFactorDisableResultSchema } from '@/lib/security/two-factor-credentials'
import { hasActiveTwoFactorProfile } from '@/lib/security/two-factor-active-profile'
import { createLogger } from '@/lib/utils/logger'
import { z } from 'zod'
import { readTwoFactorJson } from '@/lib/security/two-factor-http-contract'

const logger = createLogger('2fa-disable')

const DisableTwoFactorSchema = z
  .object({
    password: z.string().min(1).max(4096),
  })
  .strict()

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const decodedBody = await readTwoFactorJson(request)
    if (!decodedBody.ok && decodedBody.reason === 'too_large') {
      return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
    }
    if (!decodedBody.ok) {
      return badRequest('Invalid JSON body')
    }

    const parsedBody = DisableTwoFactorSchema.safeParse(decodedBody.value)
    if (!parsedBody.success) {
      return badRequest('Password is required')
    }
    const { password } = parsedBody.data

    // Verify the user's password by attempting sign-in
    const userEmail = user.email
    if (!userEmail) {
      return badRequest('No email associated with this account')
    }

    const verifyClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    )

    const { data: signInData, error: signInError } = await verifyClient.auth.signInWithPassword({
      email: userEmail,
      password,
    })

    if (signInError || signInData.user?.id !== user.id || signInData.session?.user.id !== user.id) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 })
    }

    const { data, error } = await supabase.rpc('disable_two_factor_credentials_atomic', {
      p_user_id: user.id,
    })

    if (error) {
      logger.error('[2FA Disable] Disablement RPC failed:', error)
      return serverError('Failed to disable 2FA')
    }

    const parsed = twoFactorDisableResultSchema.safeParse(data)
    if (!parsed.success) {
      logger.error('[2FA Disable] Disablement RPC returned an invalid response')
      return serverError('Failed to disable 2FA')
    }
    if (parsed.data.status === 'suspended') {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (parsed.data.status === 'not_enabled') {
      return badRequest('2FA is not enabled')
    }
    if (parsed.data.status !== 'disabled') {
      logger.error('[2FA Disable] Disablement was rejected', {
        status: parsed.data.status,
      })
      return serverError('Failed to disable 2FA')
    }

    if (!(await hasActiveTwoFactorProfile(user))) {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }

    return NextResponse.json({ success: true, viewerId: user.id, status: 'disabled' })
  },
  {
    name: '2fa-disable',
    rateLimit: 'sensitive',
  }
)
