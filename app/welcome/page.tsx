import type { Metadata } from 'next'
'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// UF3+UF4: Redirect /welcome to /onboarding (merged flow)
export const metadata: Metadata = {
  title: '欢迎 - Arena',
  description: '欢迎加入 Arena。入场，超越。',
}

export default function WelcomePage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/onboarding')
  }, [router])
  return null
}
