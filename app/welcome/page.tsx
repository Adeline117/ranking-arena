'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// UF3+UF4: Redirect /welcome to /onboarding (merged flow)
export default function WelcomePage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/onboarding')
  }, [router])
  return null
}
