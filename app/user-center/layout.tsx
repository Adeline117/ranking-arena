import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'User Center | Arena',
  description: 'Manage your Arena account, membership, badges, and bookmarks.',
  alternates: {
    canonical: `${baseUrl}/user-center`,
  },
  robots: {
    index: false,
    follow: false,
  },
}

export default function UserCenterLayout({ children }: { children: React.ReactNode }) {
  return children
}
