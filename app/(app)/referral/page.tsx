import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Referral Program',
  description: 'Invite friends to Arena and earn rewards. Share your unique referral link and track your invites.',
  alternates: {
    canonical: `${BASE_URL}/referral`,
  },
  openGraph: {
    title: 'Referral Program',
    description: 'Invite friends to Arena and earn rewards.',
    url: `${BASE_URL}/referral`,
    siteName: 'Arena',
    type: 'website',
  },
}

import ReferralClient from './ReferralClient'
import { BASE_URL } from '@/lib/constants/urls'

export default function ReferralPage() {
  return <ReferralClient />
}
