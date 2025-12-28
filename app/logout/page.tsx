'use client'

import { supabase } from '../../lib/supabaseClient'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export default function LogoutPage() {
  const router = useRouter()

  useEffect(() => {
    supabase.auth.signOut().then(() => {
      router.push('/login')
    })
  }, [router])

  return <p style={{ padding: 40 }}>Logging out...</p>
}
