import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'My Posts',
}

export default function MyPostsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
