/**
 * Email Service using Resend
 *
 * Sends transactional emails (trader alerts, weekly digests).
 * Gracefully degrades if RESEND_API_KEY is not configured.
 */

import { Resend } from 'resend'
import { createLogger } from '@/lib/utils/logger'
import { BASE_URL } from '@/lib/constants/urls'

const logger = createLogger('email-service')

let resendInstance: Resend | null = null

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    return null
  }
  if (!resendInstance) {
    resendInstance = new Resend(process.env.RESEND_API_KEY)
  }
  return resendInstance
}

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Arena <noreply@arenafi.org>'

export async function sendEmail(options: {
  to: string
  subject: string
  html: string
}): Promise<boolean> {
  // Strategy 1: Resend (primary)
  const resend = getResend()
  if (resend) {
    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: options.to,
        subject: options.subject,
        html: options.html,
      })
      logger.info('Email sent via Resend', { to: options.to, subject: options.subject })
      return true
    } catch (error) {
      logger.error('Resend send failed', { error, to: options.to })
      return false
    }
  }

  // No provider configured — log content so nothing is silently lost
  logger.warn(`[EMAIL NOT SENT] No provider. To: ${options.to} | Subject: ${options.subject}`)
  logger.info(`[EMAIL CONTENT] ${options.html.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').slice(0, 300)}...`)
  return false
}

export function buildTraderAlertEmail(alerts: Array<{ title: string; message: string; link?: string }>): string {
  const alertRows = alerts.map(a => `
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid #2a2a3e;">
        <strong style="color: #e2e8f0;">${a.title}</strong>
        <p style="margin: 4px 0 0; color: #94a3b8; font-size: 14px;">${a.message}</p>
        ${a.link ? `<a href="${BASE_URL}${a.link}" style="color: #6366f1; font-size: 13px;">View details &rarr;</a>` : ''}
      </td>
    </tr>
  `).join('')

  return `
    <div style="max-width: 600px; margin: 0 auto; background: #0f0e1a; color: #e2e8f0; font-family: -apple-system, sans-serif; padding: 24px;">
      <h1 style="font-size: 20px; margin: 0 0 8px;">Arena Trader Alerts</h1>
      <p style="color: #94a3b8; margin: 0 0 24px; font-size: 14px;">Your followed traders had significant changes:</p>
      <table style="width: 100%; border-collapse: collapse; background: #1a1a2e; border-radius: 8px; overflow: hidden;">
        ${alertRows}
      </table>
      <p style="margin: 24px 0 0; font-size: 12px; color: #64748b;">
        <a href="${BASE_URL}/settings" style="color: #6366f1;">Manage notification preferences</a>
      </p>
    </div>
  `
}

export function buildWeeklyDigestEmail(stats: {
  topMovers: Array<{ name: string; change: string; link: string }>
  newTraders: number
  totalTracked: number
  weekRange: string
}): string {
  const moverRows = stats.topMovers.map(m => `
    <tr>
      <td style="padding: 8px 16px; border-bottom: 1px solid #2a2a3e;">
        <a href="${BASE_URL}${m.link}" style="color: #e2e8f0; text-decoration: none; font-weight: 500;">${m.name}</a>
        <span style="float: right; color: ${m.change.startsWith('+') ? '#22c55e' : '#ef4444'}; font-size: 14px;">${m.change}</span>
      </td>
    </tr>
  `).join('')

  return `
    <div style="max-width: 600px; margin: 0 auto; background: #0f0e1a; color: #e2e8f0; font-family: -apple-system, sans-serif; padding: 24px;">
      <h1 style="font-size: 20px; margin: 0 0 4px;">Arena Weekly Digest</h1>
      <p style="color: #94a3b8; margin: 0 0 24px; font-size: 14px;">${stats.weekRange}</p>

      <div style="background: #1a1a2e; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
        <p style="margin: 0; font-size: 14px; color: #94a3b8;">
          <strong style="color: #e2e8f0;">${stats.totalTracked.toLocaleString()}</strong> traders tracked &middot;
          <strong style="color: #e2e8f0;">${stats.newTraders}</strong> new this week
        </p>
      </div>

      ${stats.topMovers.length > 0 ? `
        <h2 style="font-size: 16px; margin: 0 0 12px; color: #e2e8f0;">Top Movers</h2>
        <table style="width: 100%; border-collapse: collapse; background: #1a1a2e; border-radius: 8px; overflow: hidden;">
          ${moverRows}
        </table>
      ` : ''}

      <p style="margin: 24px 0 0; text-align: center;">
        <a href="${BASE_URL}" style="display: inline-block; background: #6366f1; color: #fff; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-size: 14px;">View Full Rankings</a>
      </p>

      <p style="margin: 24px 0 0; font-size: 12px; color: #64748b; text-align: center;">
        <a href="${BASE_URL}/settings" style="color: #6366f1;">Manage notification preferences</a>
      </p>
    </div>
  `
}
