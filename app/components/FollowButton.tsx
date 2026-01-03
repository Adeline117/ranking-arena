'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'

type FollowButtonProps = {
  traderId: string
  userId: string | null
  initialFollowing?: boolean
}

export default function FollowButton({ traderId, userId, initialFollowing = false }: FollowButtonProps) {
  const [following, setFollowing] = useState(initialFollowing)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!userId) return
    checkFollowing()
  }, [userId, traderId])

  const checkFollowing = async () => {
    if (!userId) return
    try {
      const { data } = await supabase
        .from('follows')
        .select('*')
        .eq('user_id', userId)
        .eq('trader_id', traderId)
        .maybeSingle()
      setFollowing(!!data)
    } catch (error) {
      console.error('Check following error:', error)
    }
  }

  const handleToggle = async () => {
    if (!userId) {
      alert('请先登录')
      return
    }

    setLoading(true)
    try {
      if (following) {
        await supabase
          .from('follows')
          .delete()
          .eq('user_id', userId)
          .eq('trader_id', traderId)
        setFollowing(false)
      } else {
        await supabase
          .from('follows')
          .insert({ user_id: userId, trader_id: traderId })
        setFollowing(true)
      }
    } catch (error) {
      console.error('Toggle follow error:', error)
      alert('操作失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  if (!userId) {
    return (
      <button
        onClick={() => window.location.href = '/login'}
        style={{
          padding: '8px 16px',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(255,255,255,0.05)',
          color: '#eaeaea',
          fontWeight: 700,
          fontSize: '13px',
          cursor: 'pointer',
        }}
      >
        关注
      </button>
    )
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      style={{
        padding: '8px 16px',
        borderRadius: '8px',
        border: following ? '1px solid rgba(255,255,255,0.2)' : 'none',
        background: following ? 'rgba(255,255,255,0.05)' : '#8b6fa8',
        color: '#eaeaea',
        fontWeight: 700,
        fontSize: '13px',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
      }}
    >
      {loading ? '...' : following ? '已关注' : '关注'}
    </button>
  )
}

