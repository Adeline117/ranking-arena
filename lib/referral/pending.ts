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
 * The fix: capture `?ref` universally (even pre-hydration on the homepage — see
 * the inline <script> in app/layout.tsx) into localStorage, then a single
 * unified trigger (ReferralAutoApply) applies it once after ANY signup path.
 *
 * IMPORTANT — the pre-hydration inline script in app/layout.tsx duplicates this
 * key + charset + JSON shape by hand (it cannot import this module). If you
 * change PENDING_REF_KEY, REF_CODE_PATTERN, or the stored `{ code, ts }` shape
 * here, you MUST update that inline script in lockstep.
 */

/** localStorage key holding the pending referral. Keep in sync with app/layout.tsx inline script. */
export const PENDING_REF_KEY = 'arena_pending_ref'

/** Pending referral is valid for 30 days after capture. */
const PENDING_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Allowed referral code charset: 2–64 chars of [A-Za-z0-9_-].
 * Codes are either a `referral_code` or a user `handle`; this rejects junk /
 * injection attempts before we ever store or send them. Keep in sync with the
 * inline script in app/layout.tsx.
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
