/**
 * Pending referral capture/apply helpers.
 *
 * Problem this solves (GAP #2 / #3):
 * - A visitor can land on the homepage `/` with `?ref=CODE`, but the homepage
 *   deliberately renders NO Providers (for LCP), so no React code runs to read
 *   the param. By the time they navigate to /login the `?ref` is gone.
 * - Privy/Web3 signup routes new users straight to /onboarding and never touched
 *   the referral apply path at all.
 *
 * V1 deliberately suspends capture and application. The helpers remain so a
 * separately reviewed re-publication can restore an explicit browser flow, but
 * every read and write is a no-op while the checked-in publication hold is
 * active. The old storage namespace is intentionally retired, so a future
 * publication cannot silently replay a value captured before this hold.
 */

import { isV1ReferralProgramPublished } from './v1-publication'

/** New namespace deliberately excludes legacy pre-V1 capture records. */
export const PENDING_REF_KEY = 'arena_pending_referral_v1'

/** Pending referral is valid for 30 days after capture. */
const PENDING_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Allowed referral code charset: 2–64 chars of [A-Za-z0-9_-].
 * Codes are either a `referral_code` or a user `handle`; this rejects junk /
 * injection attempts before a separately reviewed published flow could store
 * or send them.
 */
const REF_CODE_PATTERN = /^[A-Za-z0-9_-]{2,64}$/

interface PendingRef {
  code: string
  ts: number
}

function isValidCode(code: string | null | undefined): code is string {
  return typeof code === 'string' && REF_CODE_PATTERN.test(code)
}

/** Read + TTL-check the stored pending ref. Returns null (and does NOT delete) on miss/expiry/corruption. */
function readPending(): PendingRef | null {
  if (!isV1ReferralProgramPublished()) return null
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PENDING_REF_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRef> | null
    if (!parsed || !isValidCode(parsed.code) || typeof parsed.ts !== 'number') return null
    if (Date.now() - parsed.ts > PENDING_REF_TTL_MS) return null
    return { code: parsed.code, ts: parsed.ts }
  } catch {
    // localStorage / JSON can throw (private mode, quota, corruption) — fail open.
    return null
  }
}

/**
 * Capture a `?ref` code from the given search string (or `window.location.search`)
 * into localStorage. Only overwrites when there is no existing unexpired ref, so
 * an earlier capture (e.g. from the homepage) is never clobbered by a later page.
 * SSR-safe and never throws.
 */
export function capturePendingReferral(search?: string): void {
  if (!isV1ReferralProgramPublished()) return
  if (typeof window === 'undefined') return
  try {
    const source = search ?? window.location.search
    const code = new URLSearchParams(source).get('ref')
    if (!isValidCode(code)) return

    // Don't clobber an earlier, still-valid ref.
    if (readPending()) return

    window.localStorage.setItem(PENDING_REF_KEY, JSON.stringify({ code, ts: Date.now() }))
  } catch {
    // Fail open — referral capture must never break navigation.
  }
}

/** Read the pending ref code without consuming it. Returns null if absent/expired. */
export function peekPendingReferral(): string | null {
  return readPending()?.code ?? null
}

/**
 * Read the pending ref code AND delete the key. Returns the code (or null).
 * Call this only after a successful (or definitively-terminal) apply so a
 * transient network failure leaves the ref in place for a retry next mount.
 */
export function consumePendingReferral(): string | null {
  if (!isV1ReferralProgramPublished()) return null
  const pending = readPending()
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(PENDING_REF_KEY)
    } catch {
      // ignore
    }
  }
  return pending?.code ?? null
}
