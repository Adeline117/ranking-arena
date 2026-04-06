import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'User Center',
  description: 'Manage your Arena account, membership, badges, and bookmarks.',
  alternates: {
    canonical: `${BASE_URL}/user-center`,
  },
  robots: {
    index: false,
    follow: false,
  },
}

export default function UserCenterLayout({ children }: { children: React.ReactNode }) {
  return children
}
