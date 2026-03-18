import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyUnsubscribeToken } from '@/lib/utils/unsubscribe-token'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('email-unsubscribe')

export const dynamic = 'force-dynamic'

/**
 * GET /api/email/unsubscribe?token=xxx
 *
 * Validates HMAC token, disables email digest for the user.
 * No auth required — this is called from email footer links.
 * Returns a simple HTML page confirming the unsubscribe.
 */
export async function GET(req: NextRequest) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.public)
  if (rateLimitResp) return rateLimitResp

  const token = req.nextUrl.searchParams.get('token')

  if (!token) {
    return renderPage('Invalid Link', 'The unsubscribe link is missing a token. Please use the link from your email.', false)
  }

  const payload = verifyUnsubscribeToken(token)
  if (!payload) {
    return renderPage('Invalid or Expired Link', 'This unsubscribe link is invalid or has expired. You can manage your email preferences in Settings.', false)
  }

  try {
    const supabase = getSupabaseAdmin()

    const updateData: Record<string, unknown> = {}

    if (payload.type === 'digest') {
      updateData.email_digest = 'none'
    } else if (payload.type === 'all') {
      updateData.email_digest = 'none'
      updateData.notify_follow = false
      updateData.notify_like = false
      updateData.notify_comment = false
      updateData.notify_mention = false
      updateData.notify_message = false
    }

    const { error } = await supabase
      .from('user_profiles')
      .update(updateData)
      .eq('id', payload.userId)

    if (error) {
      logger.error('Failed to update user preferences', { userId: payload.userId, error: error.message })
      return renderPage('Something Went Wrong', 'We could not update your preferences. Please try again or manage your settings directly.', false)
    }

    logger.info('User unsubscribed via email link', { userId: payload.userId, type: payload.type })

    const message = payload.type === 'all'
      ? 'You have been unsubscribed from all Arena email notifications.'
      : 'You have been unsubscribed from the Arena email digest.'

    return renderPage('Unsubscribed Successfully', message, true)
  } catch (err) {
    logger.error('Unsubscribe endpoint error', { error: err instanceof Error ? err.message : String(err) })
    return renderPage('Something Went Wrong', 'An unexpected error occurred. Please try again later.', false)
  }
}

function renderPage(title: string, message: string, success: boolean): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Arena</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      max-width: 480px;
      width: 100%;
      background: #141414;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 40px 32px;
      text-align: center;
    }
    .icon {
      width: 48px;
      height: 48px;
      margin: 0 auto 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      background: ${success ? '#052e16' : '#2a1215'};
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #fafafa;
    }
    p {
      font-size: 14px;
      line-height: 1.6;
      color: #a3a3a3;
      margin-bottom: 24px;
    }
    a {
      display: inline-block;
      padding: 10px 24px;
      background: #262626;
      color: #fafafa;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.15s;
    }
    a:hover { background: #333; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '&#10003;' : '&#10007;'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/">Go to Arena</a>
  </div>
</body>
</html>`

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
