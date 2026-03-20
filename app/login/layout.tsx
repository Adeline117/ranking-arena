import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Login',
  description: 'Sign in to Arena - access crypto trader rankings, follow top traders, and join the community.',
  openGraph: {
    title: 'Login',
    description: 'Sign in to Arena - access crypto trader rankings, follow top traders, and join the community.',
    url: `${BASE_URL}/login`,
    siteName: 'Arena',
    type: 'website',
  },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
