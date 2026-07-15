/**
 * Pro trader-alert scheduler.
 *
 * The durable in-app notification, audit trail and baseline advance happen in
 * one database transaction. Push and email follow only newly finalized events.
 */

import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import logger from '@/lib/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { runTraderAlerts, type DeliveredTraderAlert } from '@/lib/alerts/run-trader-alerts'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getPushNotificationService } from '@/lib/services/push-notification'
import { sendEmail, buildTraderAlertEmail } from '@/lib/services/email'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function sendPushNotifications(alerts: DeliveredTraderAlert[]): Promise<number> {
  if (alerts.length === 0) return 0

  try {
    const pushService = getPushNotificationService()
    let sent = 0
    const batchSize = 10
    for (let index = 0; index < alerts.length; index += batchSize) {
      const results = await Promise.allSettled(
        alerts.slice(index, index + batchSize).map((alert) =>
          pushService.sendToUser(alert.userId, {
            title: alert.title,
            body: alert.message,
            data: {
              url: alert.link,
              type: alert.notificationType,
              deliveryId: alert.deliveryId,
            },
          })
        )
      )
      sent += results.filter((result) => result.status === 'fulfilled').length
    }
    return sent
  } catch (error) {
    logger.warn('[TraderAlerts Cron] Push delivery failed', { error })
    return 0
  }
}

async function sendAlertEmails(alerts: DeliveredTraderAlert[]): Promise<number> {
  if (alerts.length === 0) return 0

  try {
    const supabase = getSupabaseAdmin()
    const byUser = new Map<string, DeliveredTraderAlert[]>()
    for (const alert of alerts) {
      const userAlerts = byUser.get(alert.userId) ?? []
      userAlerts.push(alert)
      byUser.set(alert.userId, userAlerts)
    }

    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('id, email, email_digest')
      .in('id', [...byUser.keys()])
    if (error) throw error

    let sent = 0
    for (const profile of profiles ?? []) {
      if (!profile.email || profile.email_digest === 'none') continue
      const userAlerts = byUser.get(profile.id)
      if (!userAlerts?.length) continue
      const emailDeliveryKey = createHash('sha256')
        .update(
          userAlerts
            .map((alert) => alert.deliveryId)
            .sort()
            .join('.')
        )
        .digest('hex')

      const delivered = await sendEmail({
        to: profile.email,
        subject: `Arena: ${userAlerts.length} trader alert${userAlerts.length === 1 ? '' : 's'} triggered`,
        html: buildTraderAlertEmail(
          userAlerts.map((alert) => ({
            title: alert.title,
            message: alert.message,
            link: alert.link,
          }))
        ),
        idempotencyKey: `trader-alert/${emailDeliveryKey}`,
      })
      if (delivered) sent++
    }
    return sent
  } catch (error) {
    logger.warn('[TraderAlerts Cron] Email delivery failed', { error })
    return 0
  }
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const pipeline = await PipelineLogger.start('check-trader-alerts')

  try {
    const result = await runTraderAlerts(getSupabaseAdmin())
    const [pushSent, emailsSent] = await Promise.all([
      sendPushNotifications(result.deliveredAlerts),
      sendAlertEmails(result.deliveredAlerts),
    ])

    await pipeline.success(result.alertsSent, {
      alertsChecked: result.alertsChecked,
      tradersChecked: result.tradersChecked,
      skippedNoSubscription: result.alertsSkippedNoSubscription,
      deliveryFailures: result.deliveryFailures,
    })

    return NextResponse.json({
      ok: true,
      message: 'Trader alerts check completed',
      durationMs: Date.now() - startedAt,
      ...result,
      deliveredAlerts: undefined,
      pushSent,
      emailsSent,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error('[TraderAlerts Cron] Execution failed', { error })
    await pipeline.error(error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
