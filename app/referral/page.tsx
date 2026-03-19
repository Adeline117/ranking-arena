import { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Referral Program | Arena',
  description: 'Invite friends to Arena and earn rewards. Share your unique referral link and track your invites.',
  alternates: {
    canonical: `${baseUrl}/referral`,
  },
  openGraph: {
    title: 'Referral Program',
    description: 'Invite friends to Arena and earn rewards.',
    url: `${baseUrl}/referral`,
    siteName: 'Arena',
    type: 'website',
  },
}

import ReferralClient from './ReferralClient'

export default function ReferralPage() {
  return <ReferralClient />
}
