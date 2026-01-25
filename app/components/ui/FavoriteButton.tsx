'use client'

import { useState, useEffect, useRef } from 'react'
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
  // 使用 ref 防止重复点击（比 loading state 更可靠）
  const pendingRef = useRef(false)

  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()

    ;(async () => {
      try {
        const { data } = await supabase
          .from('favorites')
          .select('*')
          .eq('user_id', userId)
          .eq('trader_id', traderId)
          .maybeSingle()

        if (!controller.signal.aborted) {
          setFavorited(!!data)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('Check favorite error:', error)
        }
      }
    })()

    return () => controller.abort()
  }, [userId, traderId])

  const handleToggle = async () => {
    if (!userId) {
      showToast('请先登录', 'warning')
      return
    }

    // 防止重复点击
    if (pendingRef.current) {
      return
    }
    pendingRef.current = true
    setLoading(true)

    // 保存当前状态用于回滚
    const previousState = favorited
    const newState = !favorited

    // 乐观更新 UI
    setFavorited(newState)

    try {
      if (previousState) {
        // 取消收藏
        const { error } = await supabase
          .from('favorites')
          .delete()
          .eq('user_id', userId)
          .eq('trader_id', traderId)
        if (error) throw error
        showToast('已取消收藏', 'success')
      } else {
        // 添加收藏
        const { error } = await supabase
          .from('favorites')
          .insert({ user_id: userId, trader_id: traderId })
        if (error) throw error
        showToast('已收藏', 'success')
      }
    } catch (error) {
      console.error('Toggle favorite error:', error)
      // 回滚乐观更新
      setFavorited(previousState)
      showToast('操作失败，请重试', 'error')
    } finally {
      setLoading(false)
      pendingRef.current = false
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={!userId || loading}
      aria-label={favorited ? '取消收藏' : '收藏'}
      aria-pressed={favorited}
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        border: 'none',
        background: 'transparent',
        color: favorited ? '#ff7c7c' : '#9a9a9a',
        cursor: userId && !loading ? 'pointer' : 'not-allowed',
        fontSize: '20px',
        minHeight: '44px',
        minWidth: '44px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 200ms ease',
      }}
      title={favorited ? '取消收藏' : '收藏'}
    >
      <span aria-hidden="true">{favorited ? '★' : '☆'}</span>
    </button>
  )
}

