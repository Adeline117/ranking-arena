'use client'

/**
 * ReferralAutoApply — unified, best-effort referral applier.
 *
 * Mounted inside the (app) Providers tree so it runs on EVERY authenticated
 * page (email/OTP signup, OAuth callback landing, and Privy → /onboarding all
 * live under app/(app)/). It bridges the gap where a `?ref` code was captured
 * on an earlier page (e.g. the Provider-less homepage) but the signup happened
 * elsewhere.
 *
 * Behavior:
 * - On mount and whenever auth transitions to signed-in, if there is a pending
 *   referral code, POST it to /api/referral/apply once per session.
 * - The apply route is IDEMPOTENT (a second apply once referred_by is set is
 *   rejected with 400), so overlapping with LoginPageClient's own apply is safe.
 * - On success OR a terminal 4xx ("already applied" / not found / etc.) we
 *   consume (delete) the pending ref. On a network error we leave it so the
 *   next mount retries.
 * - Never throws, never blocks render. NEVER sets referred_by directly — the
 *   apply route stays the single source of truth.
 */

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { authedFetch } from '@/lib/api/client'
import { peekPendingReferral, consumePendingReferral } from '@/lib/referral/pending'
import { logger } from '@/lib/logger'

// Module-level guard: at most one in-flight/completed apply attempt per page
// session, even if the component remounts across route changes.
let attemptedThisSession = false

async function tryApplyPendingReferral(): Promise<void> {
  if (attemptedThisSession) return

  const code = peekPendingReferral()
  if (!code) return

  attemptedThisSession = true

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) {
      // Not signed in yet — allow a later trigger (onAuthStateChange) to retry.
      attemptedThisSession = false
      return
    }

    const res = await authedFetch('/api/referral/apply', 'POST', token, { code })

    // status 0 = network/timeout abort → leave pending for a retry next mount.
    if (res.status === 0) {
      attemptedThisSession = false
      logger.warn('[referral] apply network error — will retry on next mount')
      return
    }

    // Success OR any terminal 4xx (already applied / not found / self-referral /
    // invalid) → the code is spent; clear it so we don't keep retrying.
    consumePendingReferral()
    if (!res.ok) {
      logger.info(`[referral] apply not accepted (status ${res.status}) — cleared pending ref`)
    }
  } catch (err) {
    // Unexpected throw — leave pending for a retry.
    attemptedThisSession = false
    logger.error('[referral] apply failed (non-fatal):', err)
  }
}

export default function ReferralAutoApply() {
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    // Attempt immediately (covers users already signed in on mount).
    void tryApplyPendingReferral()

    // And when auth transitions to signed-in (covers signup completing while
    // this component is already mounted — email/OAuth/Privy).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mountedRef.current) return
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
        void tryApplyPendingReferral()
      }
    })

    return () => {
      mountedRef.current = false
      subscription.unsubscribe()
    }
  }, [])

  return null
}
