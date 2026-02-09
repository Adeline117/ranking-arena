'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

export default function CreatePostFAB() {
  const { accessToken, authChecked } = useAuthSession()
  const router = useRouter()
  const [hover, setHover] = useState(false)
  const loggedIn = authChecked && !!accessToken

  if (!loggedIn) return null

  return (
    <button
      onClick={() => {
        // Navigate to group selection or last-used group's new post page
        const lastGroup = typeof window !== 'undefined' ? localStorage.getItem('last_post_group_id') : null
        if (lastGroup) {
          router.push(`/groups/${lastGroup}/new`)
        } else {
          router.push('/groups')
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="发帖"
      style={{
        position: 'fixed',
        bottom: 80,
        right: 24,
        zIndex: tokens.zIndex.sticky,
        width: 56,
        height: 56,
        borderRadius: '50%',
        border: 'none',
        background: tokens.gradient.primary,
        color: tokens.colors.white,
        cursor: 'pointer',
        boxShadow: hover
          ? '0 8px 24px var(--color-accent-primary-40)'
          : '0 4px 16px var(--color-accent-primary-20)',
        transform: hover ? 'scale(1.08)' : 'scale(1)',
        transition: 'all 0.2s ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  )
}
