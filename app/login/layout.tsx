import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Login — Arena',
  description: 'Sign in to Arena - access crypto trader rankings, follow top traders, and join the community.',
  openGraph: {
    title: 'Login — Arena',
    description: 'Sign in to Arena - access crypto trader rankings, follow top traders, and join the community.',
    url: 'https://www.arenafi.org/login',
    siteName: 'Arena',
    type: 'website',
  },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
