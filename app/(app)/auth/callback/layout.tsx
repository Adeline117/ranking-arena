import type { Metadata } from 'next'

export const revalidate = 0 // Auth callback: no cache

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function AuthCallbackLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
