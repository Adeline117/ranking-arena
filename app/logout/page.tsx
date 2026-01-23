'use client'

import { supabase } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

export default function LogoutPage() {
  const router = useRouter()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    supabase.auth.signOut().then(() => {
      if (mountedRef.current) {
        router.push('/login')
      }
    }).catch(() => {
      if (mountedRef.current) {
        router.push('/login')
      }
    })
    return () => {
      mountedRef.current = false
    }
  }, [router])

  return <p style={{ padding: 40 }}>Logging out...</p>
}
