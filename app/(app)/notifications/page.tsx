/**
 * U10-5: /notifications is retired as a separate notification center.
 *
 * Two parallel notification UIs (/inbox notifications tab vs /notifications)
 * had divergent filters, visuals, and entry points — a user reached two
 * different pages for the same data depending on how they navigated. We
 * converge on /inbox as the single canonical hub (notifications + messages
 * tabs) and permanently redirect /notifications there, mirroring the saved-hub
 * consolidation. Any lingering links (e.g. MobileProfileMenu) resolve here.
 */

import { redirect } from 'next/navigation'

export default function NotificationsPage() {
  redirect('/inbox')
}
