/**
 * Telegram Bot Webhook Endpoint
 *
 * Receives updates from Telegram Bot API and dispatches to command handlers.
 * Set webhook via: POST https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://www.arenafi.org/api/telegram/webhook?secret=<WEBHOOK_SECRET>
 *
 * Security: Validates webhook secret query parameter to prevent unauthorized access.
 */

import { NextRequest, NextResponse } from 'next/server'
import { handleTelegramUpdate } from '@/lib/services/telegram-bot'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(request: NextRequest) {
  // Validate webhook secret
  const secret = request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const update = await request.json()

    // Process asynchronously to respond fast to Telegram
    // Telegram expects 200 within ~60s, but we should respond immediately
    handleTelegramUpdate(update).catch((err) => {
      logger.error('[TelegramWebhook] Async handler error:', err)
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    logger.error('[TelegramWebhook] Parse error:', err)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

/**
 * GET endpoint for webhook health check / setup info
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    bot: 'Arena Trading Bot',
    commands: ['/rank', '/top', '/follow', '/unfollow', '/price', '/stats', '/help'],
  })
}
