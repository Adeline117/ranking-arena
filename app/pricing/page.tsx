import { redirect } from 'next/navigation'

/**
 * Redirects /pricing to /user-center?tab=membership
 * Pricing plans are now integrated into the membership tab.
 */
export default function PricingPage() {
  redirect('/user-center?tab=membership')
}
