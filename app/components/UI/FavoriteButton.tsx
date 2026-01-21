'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'

type FavoriteButtonProps = {
  traderId: string
  userId: string | null
  initialFavorited?: boolean
}

export default function FavoriteButton({ traderId, userId, initialFavorited = false }: FavoriteButtonProps) {
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
      alert('请先登录')
      return
    }

    // 保存当前状态用于回滚
    const previousState = favorited
    const newState = !favorited

    // 乐观更新 UI
    setFavorited(newState)
    setLoading(true)

    try {
      if (previousState) {
        // 取消收藏
        const { error } = await supabase
          .from('favorites')
          .delete()
          .eq('user_id', userId)
          .eq('trader_id', traderId)
        if (error) throw error
      } else {
        // 添加收藏
        const { error } = await supabase
          .from('favorites')
          .insert({ user_id: userId, trader_id: traderId })
        if (error) throw error
      }
    } catch (error) {
      console.error('Toggle favorite error:', error)
      // 回滚乐观更新
      setFavorited(previousState)
      alert('操作失败，请重试')
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

