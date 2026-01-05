'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { SkeletonLine } from '../UI/Skeleton'
import EmptyState from '../UI/EmptyState'
import ErrorMessage from '../UI/ErrorMessage'
import { ChartIcon } from '../Icons'
import { Box, Text, Button } from '../Base'

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
  const [showCustomize, setShowCustomize] = useState(false)
  const [customPairs, setCustomPairs] = useState<string[]>(['BTC-USD', 'ETH-USD', 'SOL-USD', 'ARB-USD'])
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
      if (data.user?.id) {
        // 加载用户自定义的币种
        loadCustomPairs(data.user.id)
      }
    })
  }, [])

  const loadCustomPairs = async (uid: string) => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('market_pairs')
        .eq('id', uid)
        .maybeSingle()
      if (data?.market_pairs && Array.isArray(data.market_pairs)) {
        setCustomPairs(data.market_pairs)
      }
    } catch (err) {
      console.error('Load custom pairs error:', err)
    }
  }

  const saveCustomPairs = async (pairs: string[]) => {
    if (!userId) return
    try {
      await supabase
        .from('profiles')
        .update({ market_pairs: pairs })
        .eq('id', userId)
      setCustomPairs(pairs)
      setShowCustomize(false)
    } catch (err) {
      console.error('Save custom pairs error:', err)
      alert('保存失败，请重试')
    }
  }

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const pairsParam = customPairs.join(',')
        const res = await fetch(`/api/market?pairs=${encodeURIComponent(pairsParam)}`, { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return

        if (json.error) {
          setError(json.error)
          setMarket([])
        } else {
          // 过滤出用户自定义的币种
          const filteredRows = (json.rows ?? []).filter((row: MarketRow) =>
            customPairs.includes(row.symbol)
          )
          setMarket(filteredRows)
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
  }, [customPairs])

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
            style={{
              marginTop: tokens.spacing[3],
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing[2],
            }}
          >
            <Box
              bg="primary"
              p={2}
              radius="md"
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
                textAlign: 'center',
              }}
            >
              每3秒自动刷新
            </Box>
            {userId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCustomize(!showCustomize)}
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  padding: tokens.spacing[2],
                }}
              >
                {showCustomize ? '完成' : '自定义显示'}
              </Button>
            )}
            {showCustomize && userId && (
              <MarketCustomizePanel
                currentPairs={customPairs}
                onSave={saveCustomPairs}
                onCancel={() => setShowCustomize(false)}
              />
            )}
          </Box>
        </>
      )}
    </Box>
  )
}

// 自定义币种面板
function MarketCustomizePanel({
  currentPairs,
  onSave,
  onCancel,
}: {
  currentPairs: string[]
  onSave: (pairs: string[]) => void
  onCancel: () => void
}) {
  const [selectedPairs, setSelectedPairs] = useState<string[]>(currentPairs)
  const availablePairs = [
    'BTC-USD', 'ETH-USD', 'SOL-USD', 'ARB-USD', 'BNB-USD', 'XRP-USD',
    'ADA-USD', 'DOGE-USD', 'AVAX-USD', 'LINK-USD', 'MATIC-USD', 'DOT-USD',
  ]

  const togglePair = (pair: string) => {
    setSelectedPairs((prev) =>
      prev.includes(pair)
        ? prev.filter((p) => p !== pair)
        : [...prev, pair].slice(0, 6) // 最多选择6个
    )
  }

  return (
    <Box
      bg="secondary"
      p={4}
      radius="lg"
      border="primary"
      style={{
        marginTop: tokens.spacing[2],
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[3],
      }}
    >
      <Text size="sm" weight="bold">
        选择要显示的币种（最多6个）
      </Text>
      <Box
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: tokens.spacing[2],
        }}
      >
        {availablePairs.map((pair) => (
          <button
            key={pair}
            onClick={() => togglePair(pair)}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${
                selectedPairs.includes(pair)
                  ? tokens.colors.accent.primary
                  : tokens.colors.border.secondary
              }`,
              background: selectedPairs.includes(pair)
                ? tokens.colors.accent.primary + '20'
                : tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.xs,
              cursor: 'pointer',
              fontWeight: selectedPairs.includes(pair) ? 700 : 400,
            }}
          >
            {pair.replace('-USD', '')}
          </button>
        ))}
      </Box>
      <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onSave(selectedPairs)}
          disabled={selectedPairs.length === 0}
        >
          保存
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </Box>
    </Box>
  )
}
