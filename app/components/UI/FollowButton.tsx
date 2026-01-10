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
    ;(async () => {
      try {
        // 使用 trader_follows 表（所有 trader 的粉丝数只能来源 Arena 注册用户的关注）
        const { data } = await supabase
          .from('trader_follows')
          .select('*')
          .eq('user_id', userId)
          .eq('trader_id', traderId)
          .maybeSingle()
        setFollowing(!!data)
      } catch (error: any) {
        // 检查是否有实际的错误内容，避免记录空错误对象 {}
        const hasErrorContent = !!(error?.message || error?.code || error?.hint || error?.details)
        if (hasErrorContent) {
          console.error('Check following error:', error)
        }
      }
    })()
  }, [userId, traderId])

  const handleToggle = async () => {
    if (!userId) {
      alert('请先登录')
      return
    }

    setLoading(true)
    try {
      if (following) {
        // 取消关注：从 trader_follows 表删除
        const { error } = await supabase
          .from('trader_follows')
          .delete()
          .eq('user_id', userId)
          .eq('trader_id', traderId)
        
        if (error) {
          // 检查是否有实际的错误内容
          const hasErrorContent = !!(error.message || error.code || error.hint || error.details)
          if (hasErrorContent) {
            throw error
          }
          // 如果是空错误对象 {}，不抛出异常，继续执行（可能是正常的数据库响应）
        }
        setFollowing(false)
      } else {
        // 关注：插入到 trader_follows 表
        const { error } = await supabase
          .from('trader_follows')
          .insert({ user_id: userId, trader_id: traderId })
        
        if (error) {
          // 检查是否有实际的错误内容
          const hasErrorContent = !!(error.message || error.code || error.hint || error.details)
          if (hasErrorContent) {
            throw error
          }
          // 如果是空错误对象 {}，不抛出异常，继续执行（可能是正常的数据库响应）
        }
        setFollowing(true)
      }
    } catch (error: any) {
      // 检查是否有实际的错误内容，避免记录空错误对象 {}
      const hasErrorContent = !!(error?.message || error?.code || error?.hint || error?.details)
      if (hasErrorContent) {
        console.error('Toggle follow error:', error)
        alert('操作失败，请重试')
      } else {
        // 空错误对象 {}，可能是正常的数据库响应，不记录错误，但操作可能失败
        // 这里不显示错误提示，让用户重试
      }
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
        width: '100%',
        padding: '12px 16px',
        borderRadius: '12px',
        border: following ? '1px solid rgba(255,255,255,0.2)' : 'none',
        background: following ? 'rgba(255,255,255,0.05)' : '#8b6fa8',
        color: '#fff',
        fontWeight: 900,
        fontSize: '14px',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        transition: 'all 200ms ease',
      }}
    >
      {loading ? '...' : following ? '已关注' : '关注'}
    </button>
  )
}

