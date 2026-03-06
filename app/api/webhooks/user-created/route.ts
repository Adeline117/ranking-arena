/**
 * Supabase Database Webhook: 新用户注册通知
 *
 * 配置方式: Supabase Dashboard → Database → Webhooks
 * - Table: user_profiles
 * - Events: INSERT
 * - URL: https://www.arenafi.org/api/webhooks/user-created
 * - Headers: Authorization: Bearer <CRON_SECRET>
 *
 * 也可作为手动触发端点，POST { handle, email }。
 */

import { NextRequest, NextResponse } from 'next/server'
import { notifyNewUser } from '@/lib/notifications/activity-alerts'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()

    // Supabase webhook payload: { type: 'INSERT', table: 'user_profiles', record: {...} }
    const record = body.record || body
    const handle = record.handle ?? null
    const email = record.email ?? null

    await notifyNewUser(handle, email)

    return NextResponse.json({ ok: true })
  } catch (err) {
    logger.error('[webhook/user-created] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
