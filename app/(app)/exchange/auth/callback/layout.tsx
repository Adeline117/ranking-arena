import type { Metadata } from 'next'

export const revalidate = 0 // Exchange auth callback: no cache

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function ExchangeAuthCallbackLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
