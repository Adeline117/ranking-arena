import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '关于我们',
  description: 'About Arena — crypto trader rankings and community platform aggregating 30+ exchanges.',
  alternates: {
    canonical: `${baseUrl}/about`,
  },
}

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return children
}
