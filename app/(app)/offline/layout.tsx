import type { Metadata } from 'next'

export const metadata: Metadata = {
  // Root layout template appends ' | Arena', so omit it here to avoid doubling.
  title: 'Offline',
  description: 'You are currently offline. Check your connection and try again.',
  robots: { index: false, follow: false },
}

export default function OfflineLayout({ children }: { children: React.ReactNode }) {
  return children
}
