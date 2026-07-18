/**
 * Welcome Email API Route
 *
 * Sends a welcome email to newly registered users.
 * Called fire-and-forget from the auth callback when isNewUser is detected.
 * Gracefully degrades if RESEND_API_KEY is not configured.
 */

import { NextRequest, NextResponse } from 'next/server'
import { sendEmail } from '@/lib/services/email'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { BASE_URL } from '@/lib/constants/urls'

const logger = createLogger('welcome-email')

export async function POST(request: NextRequest) {
  // Rate limit to prevent abuse
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { user, error: userError } = await extractUserFromRequest(request)

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const email = user.email
    if (!email) {
      return NextResponse.json({ ok: true, skipped: 'no_email' })
    }

    // Only send to users created within the last 2 minutes (prevents replay)
    const createdAt = new Date(user.created_at).getTime()
    const now = Date.now()
    if (now - createdAt > 120_000) {
      return NextResponse.json({ ok: true, skipped: 'not_new_user' })
    }

    const html = buildWelcomeEmail()
    const sent = await sendEmail({
      to: email,
      subject: 'Welcome to Arena! Your crypto trading edge starts here',
      html,
    })

    if (sent) {
      logger.info('Welcome email sent', { userId: user.id })
    }

    return NextResponse.json({ ok: true, sent })
  } catch (error) {
    logger.error('Welcome email failed', { error })
    // Never fail the response — this is fire-and-forget
    return NextResponse.json({ ok: true, sent: false })
  }
}

function buildWelcomeEmail(): string {
  return `
    <div style="max-width: 600px; margin: 0 auto; background: #0f0e1a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px 24px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="font-size: 24px; font-weight: 800; margin: 0 0 8px; color: #fff;">Welcome to Arena!</h1>
        <p style="color: #94a3b8; margin: 0; font-size: 15px;">Your crypto trading intelligence platform</p>
      </div>

      <div style="background: #1a1a2e; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
        <h2 style="font-size: 16px; font-weight: 700; margin: 0 0 16px; color: #e2e8f0;">Here's what you can do:</h2>

        <div style="margin-bottom: 16px; padding-left: 16px; border-left: 3px solid #6366f1;">
          <p style="margin: 0 0 4px; font-weight: 600; color: #fff;">1. Browse Rankings</p>
          <p style="margin: 0; font-size: 13px; color: #94a3b8;">Discover top traders across live CEX, DEX, and on-chain ranking source boards</p>
        </div>

        <div style="margin-bottom: 16px; padding-left: 16px; border-left: 3px solid #22c55e;">
          <p style="margin: 0 0 4px; font-weight: 600; color: #fff;">2. Follow Traders</p>
          <p style="margin: 0; font-size: 13px; color: #94a3b8;">Track performance and get alerts on your favorite traders</p>
        </div>

        <div style="padding-left: 16px; border-left: 3px solid #f59e0b;">
          <p style="margin: 0 0 4px; font-weight: 600; color: #fff;">3. Go Pro for Full Access</p>
          <p style="margin: 0; font-size: 13px; color: #94a3b8;">Unlock advanced filters, score breakdowns, trader comparison, and more</p>
        </div>
      </div>

      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${BASE_URL}/pricing" style="display: inline-block; background: #6366f1; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Start Your 7-Day Free Trial</a>
      </div>

      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${BASE_URL}" style="color: #6366f1; font-size: 14px; text-decoration: none;">Explore Rankings &rarr;</a>
      </div>

      <div style="border-top: 1px solid #2a2a3e; padding-top: 16px; text-align: center;">
        <p style="margin: 0; font-size: 12px; color: #64748b;">
          Arena &mdash; Ranking traders across live public source boards<br/>
          <a href="${BASE_URL}/settings" style="color: #6366f1;">Manage email preferences</a>
        </p>
      </div>
    </div>
  `
}
