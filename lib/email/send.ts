/**
 * Email sending stub.
 *
 * Supabase Auth handles transactional emails (confirmation, password reset).
 * This module is for application emails (weekly digest, notifications, etc.).
 *
 * TODO: integrate with Resend (https://resend.com) or SendGrid for production use.
 */

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  // Stub: log email for now, integrate Resend/SendGrid later
  console.log(`[EMAIL] To: ${to}, Subject: ${subject}`)
  if (process.env.NODE_ENV === 'development') {
    console.log(`[EMAIL] Body preview: ${html.slice(0, 200)}...`)
  }
  // TODO: integrate with Resend (https://resend.com)
  // import { Resend } from 'resend'
  // const resend = new Resend(process.env.RESEND_API_KEY)
  // await resend.emails.send({ from: 'Arena <noreply@arenafi.org>', to, subject, html })
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
    <p><a href="https://www.arenafi.org/rankings">View Full Rankings</a></p>
  `
  await sendEmail(to, 'Your Weekly Arena Digest', html)
}
