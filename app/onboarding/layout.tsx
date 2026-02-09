import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Onboarding',
  description: 'Set up your ArenaFi profile - choose your interests and connect your exchange accounts.',
}

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
