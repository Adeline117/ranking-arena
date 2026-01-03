'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { SkeletonLine } from '../UI/Skeleton'
import EmptyState from '../UI/EmptyState'
import ErrorMessage from '../UI/ErrorMessage'
import { ChartIcon } from '../Icons'
import { Box, Text } from '../Base'

type MarketRow = {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

export default function MarketPanel() {
  const [market, setMarket] = useState<MarketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await fetch('/api/market', { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return

        if (json.error) {
          setError(json.error)
          setMarket([])
        } else {
          setMarket(json.rows ?? [])
          setLastUpdate(new Date())
        }
      } catch (err: any) {
        if (!alive) return
        setError(err?.message || '加载失败')
        setMarket([])
      } finally {
        if (!alive) return
        setLoading(false)
      }
    }

    load()
    const t = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const formatTime = (date: Date) => {
    const now = new Date()
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
    if (diff < 60) return `${diff}秒前`
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <Box bg="secondary" p={4} radius="xl" border="primary">
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[3],
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <ChartIcon size={18} style={{ color: tokens.colors.text.primary }} />
          <Text size="md" weight="black">
            市场行情
          </Text>
        </Box>
        {lastUpdate && !loading && !error && (
          <Box
            bg="tertiary"
            px={2}
            py={1}
            radius="md"
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
            }}
          >
            {formatTime(lastUpdate)}
          </Box>
        )}
      </Box>

      {/* Content */}
      {loading ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Box key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <SkeletonLine width="80px" height="16px" />
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1], alignItems: 'flex-end' }}>
                <SkeletonLine width="60px" height="14px" />
                <SkeletonLine width="50px" height="12px" />
              </Box>
            </Box>
          ))}
        </Box>
      ) : error ? (
        <ErrorMessage message={error} onRetry={() => window.location.reload()} />
      ) : market.length === 0 ? (
        <EmptyState
          title="暂无行情数据"
          description="API可能暂时不可用，请稍后再试"
        />
      ) : (
        <>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {market.map((m) => (
              <Box
                key={m.symbol}
                bg="primary"
                p={3}
                radius="lg"
                border="secondary"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  transition: `all ${tokens.transition.base}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                  e.currentTarget.style.borderColor = tokens.colors.border.primary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.primary
                  e.currentTarget.style.borderColor = tokens.colors.border.secondary
                }}
              >
                <Text size="sm" weight="black">
                  {m.symbol.replace('-USD', '')}
                </Text>
                <Box style={{ textAlign: 'right' }}>
                  <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
                    ${m.price}
                  </Text>
                  <Text
                    size="xs"
                    weight="bold"
                    style={{
                      color: m.direction === 'up' ? tokens.colors.accent.success : tokens.colors.accent.error,
                    }}
                  >
                    {m.changePct}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
          <Box
            bg="primary"
            p={2}
            radius="md"
            style={{
              marginTop: tokens.spacing[3],
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
              textAlign: 'center',
            }}
          >
            每3秒自动刷新
          </Box>
        </>
      )}
    </Box>
  )
}
