import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Membership',
  description: 'Arena Pro membership - unlock advanced analytics, trader comparisons, and premium features.',
}

export default function MembershipLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
