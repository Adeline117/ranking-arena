import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'My Posts',
  description: 'Manage your posts and trade ideas shared on Arena.',
  robots: { index: false, follow: false },
}

export default function MyPostsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
