/**
 * Email sending stub.
 *
 * Supabase Auth handles transactional emails (confirmation, password reset).
 * This module is for application emails (weekly digest, notifications, etc.).
 *
 * Currently a stub — logs emails instead of sending.
 * When ready, integrate Resend (https://resend.com) or SendGrid.
 */

import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('email')

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  // Stub: log email for now, integrate Resend/SendGrid when ready
  log.warn(`To: ${to}, Subject: ${subject}, Body length: ${html.length}`)
}

/**
 * Send a weekly digest email to a user.
 * Stub for future implementation.
 */
export async function sendWeeklyDigest(
  to: string,
  data: { topTraders: { name: string; roi: number }[]; weeklyHighlight: string }
): Promise<void> {
  const html = `
    <h1>Your Weekly Arena Digest</h1>
    <p>${data.weeklyHighlight}</p>
    <h2>Top Traders This Week</h2>
    <ul>
      ${data.topTraders.map(t => `<li>${t.name}: ${t.roi > 0 ? '+' : ''}${t.roi.toFixed(1)}% ROI</li>`).join('')}
    </ul>
    <p><a href="${BASE_URL}/rankings">View Full Rankings</a></p>
  `
  await sendEmail(to, 'Your Weekly Arena Digest', html)
}
