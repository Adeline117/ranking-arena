import { redirect } from 'next/navigation'
import { features } from '@/lib/features'

/**
 * /hot — Hot posts & groups (social feature).
 * When social is disabled, redirects to /market.
 * When social is re-enabled, this should be restored to the full HotContent component.
 * Original code preserved in git history (commit before this change).
 */
export default function HotPage() {
  if (!features.social) redirect('/market')

  // When social is re-enabled, restore the original HotContent component.
  // For now, redirect to market since hot content requires social features.
  redirect('/market')
}
