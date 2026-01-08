'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { Button } from '../Base'

interface ClaimTraderButtonProps {
  traderId: string
  handle: string
  userId: string
}

export default function ClaimTraderButton({ traderId, handle, userId }: ClaimTraderButtonProps) {
  const [loading, setLoading] = useState(false)
  const [claimed, setClaimed] = useState(false)

  const handleClaim = async () => {
    if (!confirm(`确认认领交易员 "@${handle}"？\n\n认领后，此交易员账号将与您的账户合并。`)) {
      return
    }

    setLoading(true)
    try {
      // 创建认领申请
      const { error } = await supabase
        .from('trader_claims')
        .insert({
          trader_id: traderId,
          user_id: userId,
          handle: handle,
          status: 'pending', // pending, approved, rejected
        })

      if (error) {
        if (error.code === '23505') {
          // 已存在认领申请
          alert('您已经提交过认领申请，请等待审核。')
        } else {
          throw error
        }
      } else {
        setClaimed(true)
        alert('认领申请已提交！管理员审核通过后，您的账号将与交易员账号合并。')
      }
    } catch (err: any) {
      console.error('Claim trader error:', err)
      alert('申请失败：' + (err.message || '未知错误'))
    } finally {
      setLoading(false)
    }
  }

  if (claimed) {
    return (
      <Button variant="ghost" size="sm" disabled>
        已提交认领申请
      </Button>
    )
  }

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleClaim}
      disabled={loading}
    >
      {loading ? '申请中...' : '申请认领'}
    </Button>
  )
}




