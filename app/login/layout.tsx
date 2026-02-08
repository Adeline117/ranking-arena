import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Login',
  description: 'Sign in to Arena - access crypto trader rankings, follow top traders, and join the community.',
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
