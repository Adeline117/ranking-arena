import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Apply to Create a Group',
  description: 'Apply to create your own trading group on Arena. Build a community around your trading strategy.',
  alternates: {
    canonical: `${BASE_URL}/groups/apply`,
  },
  openGraph: {
    title: 'Apply to Create a Group',
    description: 'Apply to create your own trading group on Arena. Build a community around your trading strategy.',
    url: `${BASE_URL}/groups/apply`,
    siteName: 'Arena',
    type: 'website',
  },
}

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return children
}
