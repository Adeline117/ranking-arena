'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Button } from '../Base'

interface ClaimTraderButtonProps {
  traderId: string
  handle: string
  userId: string
  source?: string // 'binance', 'bybit', etc.
}

export default function ClaimTraderButton({ traderId, handle, userId, source = 'binance' }: ClaimTraderButtonProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [claimed, setClaimed] = useState(false)
  const [hasConnection, setHasConnection] = useState(false)
  const [checking, setChecking] = useState(true)

  // 检查用户是否已绑定交易所账号
  useEffect(() => {
    checkConnection()
  }, [userId, source])

  const checkConnection = async () => {
    try {
      // 检查用户是否已登录
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        console.warn('[ClaimTrader] 用户未登录')
        setHasConnection(false)
        setChecking(false)
        return
      }

      // 确保使用正确的用户ID
      const actualUserId = user.id
      if (userId !== actualUserId) {
        console.warn('[ClaimTrader] 用户ID不匹配:', { provided: userId, actual: actualUserId })
      }

      const { data, error } = await supabase
        .from('user_exchange_connections')
        .select('id, exchange, is_active')
        .eq('user_id', actualUserId)
        .eq('exchange', source)
        .eq('is_active', true)
        .maybeSingle()

      // 检查是否有实际的错误内容（空对象 {} 表示正常情况，不应该记录为错误）
      // 只有当 error 对象有实际的错误属性（message/code/hint/details）时，才是真正的错误
      if (error) {
        // 详细检查错误对象的结构，确保只有真实的值才被认为是错误内容
        const errorKeys = Object.keys(error || {})
        
        // 严格检查：只有非空、非 undefined、非 null 的值才被认为是错误内容
        const hasMessage = error.message && typeof error.message === 'string' && error.message.trim() !== ''
        const hasCode = error.code && (typeof error.code === 'string' || typeof error.code === 'number')
        const hasHint = error.hint && typeof error.hint === 'string' && error.hint.trim() !== ''
        
        // details 可能是对象，需要检查是否为空对象或只有空值的属性
        let hasDetails = false
        if (error.details) {
          if (typeof error.details === 'string' && error.details.trim() !== '') {
            hasDetails = true
          } else if (typeof error.details === 'object' && error.details !== null) {
            // 检查对象是否为空对象或只有空值的属性
            const detailsKeys = Object.keys(error.details)
            if (detailsKeys.length > 0) {
              const hasNonEmptyValue = detailsKeys.some(key => {
                const value = (error.details as any)[key]
                if (value === null || value === undefined || value === '') {
                  return false
                }
                if (typeof value === 'object') {
                  return Object.keys(value).length > 0
                }
                return true
              })
              hasDetails = hasNonEmptyValue
            }
            // 如果 detailsKeys.length === 0，hasDetails 保持为 false（空对象）
          }
        }
        
        const hasErrorContent = hasMessage || hasCode || hasHint || hasDetails
        
        // 调试：查看错误对象的实际结构（仅在开发环境且是空对象时）
        if (process.env.NODE_ENV === 'development' && !hasErrorContent) {
          // 如果错误对象存在但没有有效的错误内容，记录调试信息（不是错误）
          // 这是正常的"没找到连接"情况
          if (errorKeys.length === 0) {
            // 完全空对象 {}
            // 不记录，因为这是正常的 Supabase maybeSingle() 响应
          } else {
            // 有属性但都是空值，记录调试信息
            console.debug('[ClaimTrader] 调试：错误对象有属性但无有效内容（这是正常的，表示没找到连接）:', {
              errorKeys,
              error,
              hasMessage,
              hasCode,
              hasHint,
              hasDetails,
              userId: actualUserId,
              source,
            })
          }
        }
        
        // 只有在真正的错误（如权限错误、网络错误等）时才记录错误
        // 空错误对象 {} 不应该记录为错误
        if (hasErrorContent) {
          console.error('[ClaimTrader] 检查连接失败:', {
            error,
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
            userId: actualUserId,
            source,
          })
        }
        // 如果 hasErrorContent 是 false（空对象 {} 或所有属性都是 undefined/null/空字符串/空对象），则不记录错误
        // 这是正常的"没找到连接"情况，不应该记录为错误
      }
      
      // 无论是否有错误，都设置连接状态（没找到连接或查询失败都是 false）
      // 注意：即使是空错误对象 {}（正常的"没找到记录"情况），也应该设置连接状态为 false
      setHasConnection(!!data)
    } catch (err: any) {
      console.error('[ClaimTrader] 检查连接异常:', {
        error: err,
        message: err?.message,
        stack: err?.stack,
        userId,
        source,
      })
      setHasConnection(false)
    } finally {
      setChecking(false)
    }
  }

  const handleClaim = async () => {
    // 1. 检查是否已绑定交易所账号
    if (!hasConnection) {
      const goToSettings = confirm(
        `认领交易员账号需要先绑定您的交易所账号。\n\n` +
        `请先在设置页面绑定您的 ${source.toUpperCase()} 账号，然后才能认领。\n\n` +
        `是否前往设置页面？`
      )
      if (goToSettings) {
        router.push('/settings')
      }
      return
    }

    // 2. 确认认领
    if (!confirm(`确认认领交易员 "@${handle}"？\n\n系统将验证您是否真的拥有此账号，验证通过后才会完成认领。`)) {
      return
    }

    setLoading(true)
    try {
      // 3. 获取用户token
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        alert('请先登录')
        return
      }

      // 4. 验证账号所有权
      const verifyResponse = await fetch('/api/exchange/verify-ownership', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          exchange: source,
          traderId,
          source,
        }),
      })

      const verifyResult = await verifyResponse.json()

      if (!verifyResponse.ok) {
        if (verifyResult.needConnect) {
          const goToSettings = confirm(
            verifyResult.message + '\n\n是否前往设置页面绑定账号？'
          )
          if (goToSettings) {
            router.push('/settings')
          }
        } else {
          alert(verifyResult.message || '账号验证失败，请确保您拥有此交易员账号。')
        }
        return
      }

      if (!verifyResult.verified) {
        alert('账号验证失败：您可能不拥有此交易员账号，或者API凭证无效。')
        return
      }

      // 5. 验证通过，创建认领记录（自动批准）
      const { error } = await supabase
        .from('trader_claims')
        .insert({
          trader_id: traderId,
          user_id: userId,
          handle: handle,
          source: source,
          status: 'approved', // 验证通过后自动批准
          verified_at: new Date().toISOString(),
        })

      if (error) {
        if (error.code === '23505') {
          // 已存在认领申请
          alert('您已经认领过此交易员账号。')
        } else {
          throw error
        }
      } else {
        setClaimed(true)
        alert('认领成功！您的账号已与此交易员账号合并。')
        // 刷新页面
        window.location.reload()
      }
    } catch (err: any) {
      console.error('Claim trader error:', err)
      alert('认领失败：' + (err.message || '未知错误'))
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





