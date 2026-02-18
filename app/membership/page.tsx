import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

/**
 * Redirects /membership to /user-center?tab=membership
 * Keeps old links functional.
 */
export const metadata: Metadata = {
  title: 'Membership - Arena',
  description: 'Arena Pro membership. Unlock advanced features and premium trader analytics.',
}

export default function MembershipPage() {
  redirect('/user-center?tab=membership')
}
