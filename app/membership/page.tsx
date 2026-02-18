import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

/**
 * Redirects /membership to /user-center?tab=membership
 * Keeps old links functional.
 */
export const metadata: Metadata = {
  title: '会员 - Arena',
  description: 'Arena Pro 会员，解锁高级功能。',
}

export default function MembershipPage() {
  redirect('/user-center?tab=membership')
}
