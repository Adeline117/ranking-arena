/**
 * Email sending — re-exports from the canonical Resend-based implementation.
 *
 * All email logic lives in `lib/services/email.ts`.
 * This module exists so that any import from `@/lib/email/send` keeps working.
 */

export { sendEmail, buildTraderAlertEmail, buildWeeklyDigestEmail } from '@/lib/services/email'
