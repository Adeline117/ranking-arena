import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'Arena terms of service - rules, guidelines, and user agreements for using the platform.',
}

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
