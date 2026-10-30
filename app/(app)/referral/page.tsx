import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Referral Program Unavailable',
  description: 'Referral invitations and rewards are unavailable during the V1 verification hold.',
  alternates: {
    canonical: `${BASE_URL}/referral`,
  },
  openGraph: {
    title: 'Referral Program Unavailable',
    description:
      'Referral invitations and rewards are unavailable during the V1 verification hold.',
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
