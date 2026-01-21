'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useToast } from './Toast'

type FavoriteButtonProps = {
  traderId: string
  userId: string | null
  initialFavorited?: boolean
}

export default function FavoriteButton({ traderId, userId, initialFavorited = false }: FavoriteButtonProps) {
  const { showToast } = useToast()
  const [favorited, setFavorited] = useState(initialFavorited)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!userId) return
    ;(async () => {
      try {
        const { data } = await supabase
          .from('favorites')
          .select('*')
          .eq('user_id', userId)
          .eq('trader_id', traderId)
          .maybeSingle()
        setFavorited(!!data)
      } catch (error) {
        console.error('Check favorite error:', error)
      }
    })()
  }, [userId, traderId])

  const handleToggle = async () => {
    if (!userId) {
      showToast('请先登录', 'warning')
      return
    }

    setLoading(true)
    try {
      if (favorited) {
        const { error } = await supabase
          .from('favorites')
          .delete()
          .eq('user_id', userId)
          .eq('trader_id', traderId)
        if (error) throw error
        setFavorited(false)
        showToast('已取消收藏', 'success')
      } else {
        const { error } = await supabase
          .from('favorites')
          .insert({ user_id: userId, trader_id: traderId })
        if (error) throw error
        setFavorited(true)
        showToast('已收藏', 'success')
      }
    } catch (error) {
      console.error('Toggle favorite error:', error)
      showToast('操作失败，请重试', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={!userId || loading}
      style={{
        padding: '6px 12px',
        borderRadius: '8px',
        border: 'none',
        background: 'transparent',
        color: favorited ? '#ff7c7c' : '#9a9a9a',
        cursor: userId && !loading ? 'pointer' : 'not-allowed',
        fontSize: '18px',
        transition: 'all 200ms ease',
      }}
      title={favorited ? '取消收藏' : '收藏'}
    >
      {favorited ? '★' : '☆'}
    </button>
  )
}

