import { redirect } from 'next/navigation'

/**
 * Redirects /membership to /user-center?tab=membership
 * Keeps old links functional.
 */
export default function MembershipPage() {
  redirect('/user-center?tab=membership')
}
