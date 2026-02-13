'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Redirects /membership to /user-center?tab=membership
 * Keeps old links functional.
 */
export default function MembershipPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/user-center?tab=membership')
  }, [router])

  return null
}
