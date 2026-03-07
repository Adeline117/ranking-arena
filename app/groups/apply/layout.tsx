import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Apply to Create a Group — Arena',
  description: 'Apply to create your own trading group on Arena. Build a community around your trading strategy.',
  alternates: {
    canonical: `${baseUrl}/groups/apply`,
  },
  openGraph: {
    title: 'Apply to Create a Group — Arena',
    description: 'Apply to create your own trading group on Arena. Build a community around your trading strategy.',
    url: `${baseUrl}/groups/apply`,
    siteName: 'Arena',
    type: 'website',
  },
}

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return children
}
