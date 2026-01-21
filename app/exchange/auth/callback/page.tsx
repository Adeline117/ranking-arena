'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text } from '@/app/components/Base'
import { getCsrfHeaders } from '@/lib/api/client'

function ExchangeAuthCallbackContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState<string>('')

  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get('code')
      const state = searchParams.get('state')
      const exchange = searchParams.get('exchange')
      const error = searchParams.get('error')

      if (error) {
        setStatus('error')
        setMessage(`授权失败: ${error}`)
        return
      }

      if (!code || !state || !exchange) {
        setStatus('error')
        setMessage('缺少必要的授权参数')
        return
      }

      try {
        // 获取当前用户
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setStatus('error')
          setMessage('请先登录')
          router.push('/login')
          return
        }

        // 交换 code 获取 access_token
        const response = await fetch('/api/exchange/oauth/callback', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            ...getCsrfHeaders()
          },
          body: JSON.stringify({
            exchange,
            code,
            state,
            userId: user.id,
          }),
        })

        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || '授权失败')
        }

        setStatus('success')
        setMessage('授权成功！正在跳转...')
        
        // 3秒后跳转到设置页面
        setTimeout(() => {
          router.push('/settings')
        }, 3000)
      } catch (err) {
        setStatus('error')
        const errorMessage = err instanceof Error ? err.message : '授权失败'
        setMessage(errorMessage)
      }
    }

    handleCallback()
  }, [searchParams, router])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      
      <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10], textAlign: 'center' }}>
        {status === 'loading' && (
          <>
            <Text size="lg" style={{ marginBottom: tokens.spacing[4] }}>
              正在处理授权...
            </Text>
            <Text size="sm" color="secondary">
              请稍候
            </Text>
          </>
        )}

        {status === 'success' && (
          <>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4], color: '#7CFFB2' }}>
              ✓ 授权成功
            </Text>
            <Text size="sm" color="secondary">
              {message}
            </Text>
          </>
        )}

        {status === 'error' && (
          <>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4], color: '#ff7c7c' }}>
              ✗ 授权失败
            </Text>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {message}
            </Text>
            <button
              onClick={() => router.push('/exchange/auth')}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.primary,
                cursor: 'pointer',
              }}
            >
              重试
            </button>
          </>
        )}
      </Box>
    </Box>
  )
}

export default function ExchangeAuthCallbackPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[10], textAlign: 'center' }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    }>
      <ExchangeAuthCallbackContent />
    </Suspense>
  )
}

