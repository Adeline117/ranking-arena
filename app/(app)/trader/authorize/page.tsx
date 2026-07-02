/**
 * Trader Authorization Page — server-side redirect to the unified /claim page.
 *
 * Was a client page that showed a 2s empty flash before router.replace('/claim')
 * (UIUX_PERPAGE_AUDIT_2026-06-30 实体/详情). Authorization (live data sync) is
 * triggered automatically when a claim is verified, so this route only redirects.
 */

import { redirect } from 'next/navigation'

export default function TraderAuthorizePage() {
  redirect('/claim')
}
