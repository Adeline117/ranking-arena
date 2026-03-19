'use client'

import { useEffect, useState, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { SkeletonLine } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import ErrorMessage from '../ui/ErrorMessage'
import { ChartIcon } from '../ui/icons'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { getCache, setCache } from '@/lib/cache'
import { useToast } from '../ui/Toast'
import { logger } from '@/lib/logger'

type MarketRow = {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

export default function MarketPanel() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [market, setMarket] = useState<MarketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [showCustomize, setShowCustomize] = useState(false)
  const [customPairs, setCustomPairs] = useState<string[]>(['BTC-USD', 'ETH-USD', 'SOL-USD', 'ARB-USD'])
  const [userId, setUserId] = useState<string | null>(null)

  const loadCustomPairs = async (uid: string) => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('market_pairs')
        .eq('id', uid)
        .maybeSingle()

      if (error) {
        loadPairsFromLocalStorage()
        return
      }

      if (data?.market_pairs && Array.isArray(data.market_pairs) && data.market_pairs.length > 0) {
        setCustomPairs(data.market_pairs)
      }
    } catch (err) {
      logger.error('[MarketPanel] Load custom pairs error:', err)
      loadPairsFromLocalStorage()
    }
  }

  const loadPairsFromLocalStorage = () => {
    try {
      const raw = localStorage.getItem('market_pairs')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setCustomPairs(parsed)
        }
      }
    } catch { /* localStorage unavailable */ }
  }

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
      if (data.user?.id) {
        loadCustomPairs(data.user.id)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; loadCustomPairs and supabase are stable singletons
  }, [])

  const saveCustomPairs = async (pairs: string[]) => {
    if (!userId) return
    try {
      await supabase
        .from('user_profiles')
        .upsert({ id: userId, market_pairs: pairs }, { onConflict: 'id' })
      setCustomPairs(pairs)
      setShowCustomize(false)
    } catch (err) {
      logger.error('Save custom pairs error:', err)
      // fallback: localStorage
      try {
        localStorage.setItem('market_pairs', JSON.stringify(pairs))
        setCustomPairs(pairs)
        setShowCustomize(false)
        return
      } catch { /* intentionally empty */ }
      showToast(t('saveFailed'), 'error')
    }
  }

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        // 只在首次加载时显示 loading，后续更新不显示 loading，避免跳动
        if (market.length === 0) {
          setLoading(true)
        }
        setError(null)
        const pairsParam = customPairs.join(',')
        const cacheKey = `market_${pairsParam}`
        
        // 先检查客户端缓存（仅首次加载时使用）
        if (market.length === 0) {
          const cachedData = getCache<MarketRow[]>(cacheKey)
          if (cachedData && cachedData.length > 0) {
            setMarket(cachedData)
            setLastUpdate(new Date())
            setLoading(false)
          }
        }
        
        let res: Response
        try {
          res = await fetch(`/api/market?pairs=${encodeURIComponent(pairsParam)}`, {
            cache: 'default',
            signal: AbortSignal.timeout(15000),
          })
        } catch (fetchError: unknown) {
          const err = fetchError instanceof Error ? fetchError : new Error(String(fetchError))
          if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            setError(t('requestTimeoutShort'))
            setLoading(false)
            return
          }
          if (err.message?.includes('Failed to fetch') || err.message?.includes('fetch failed')) {
            setError(t('networkConnectionFailed'))
            setLoading(false)
            return
          }
          throw fetchError
        }
        
        if (!res.ok) {
          // 不抛出异常，而是设置错误状态
          setError(`${t('cannotGetMarketData')} (${res.status})`)
          setMarket([])
          setLoading(false)
          return
        }
        
        const json = await res.json()
        if (!alive) return

        if (json.error) {
          setError(json.error)
          setMarket([])
        } else {
          // 如果 customPairs 为空，使用默认币种
          const pairsToFilter = customPairs.length > 0 ? customPairs : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ARB-USD']
          
          // 过滤出用户自定义的币种
          const filteredRows = (json.rows ?? []).filter((row: MarketRow) =>
            pairsToFilter.includes(row.symbol)
          )
          
          if (filteredRows.length === 0 && json.rows && json.rows.length > 0) {
            // API returned data but filtering produced empty - possible symbol mismatch
          }
          
          // 只在数据真正变化时才更新，避免不必要的重新渲染
          setMarket((prevMarket) => {
            // 如果数据完全相同，不更新，避免跳动
            if (prevMarket.length === filteredRows.length &&
                prevMarket.every((prev, i) => 
                  filteredRows[i] &&
                  prev.symbol === filteredRows[i].symbol &&
                  prev.price === filteredRows[i].price &&
                  prev.changePct === filteredRows[i].changePct &&
                  prev.direction === filteredRows[i].direction
                )) {
              return prevMarket // 返回原数组，避免重新渲染
            }
            // 更新客户端缓存
            setCache(cacheKey, filteredRows, 5 * 60 * 1000) // 缓存5分钟
            return filteredRows
          })
          
          // 只在数据真正变化时才更新时间戳
          setLastUpdate((prevTime) => {
            const now = new Date()
            // 如果距离上次更新不到2秒，不更新时间戳，避免频繁更新
            if (prevTime && now.getTime() - prevTime.getTime() < 2000) {
              return prevTime
            }
            return now
          })
        }
      } catch (err: unknown) {
        if (!alive) return
        logger.error('[MarketPanel] 加载市场数据异常:', err)
        setError(err instanceof Error ? err.message : t('loadFailed'))
        if (market.length === 0) {
          setMarket([])
        }
      } finally {
        if (!alive) return
        setLoading(false)
      }
    }

    load()
    // Refresh every 30s instead of 10s — market data API already has s-maxage=30,
    // so polling faster than that just hits stale CDN cache anyway.
    const interval = setInterval(load, 30000)

    // Pause polling when tab is hidden to save bandwidth
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        load() // Refresh immediately when tab becomes visible
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      alive = false
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load function is defined in closure; only re-run when customPairs or t changes
  }, [customPairs, t])

  const formatTime = (date: Date) => {
    const now = new Date()
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
    if (diff < 60) return `${diff} ${t('secondsAgo')}`
    if (diff < 3600) return `${Math.floor(diff / 60)} ${t('minutesAgo')}`
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <Box bg="secondary" p={4} radius="xl" border="primary" style={{ minHeight: 320, contain: 'layout style' }}>
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
            {t('market')}
          </Text>
        </Box>
        {lastUpdate && !loading && !error && (
          <Box
            bg="tertiary"
            px={2}
            py={1}
            radius="md"
            suppressHydrationWarning
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
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], minHeight: 248 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Box key={i} bg="primary" p={3} radius="lg" border="secondary" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 58 }}>
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
          title={t('noData')}
          description={t('loadFailed')}
        />
      ) : (
        <>
          <Box 
            key="market-list"
            style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              gap: tokens.spacing[2],
            }}
          >
            {market.map((m) => (
              <MarketRow key={m.symbol} data={m} />
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
              Auto refresh every 30s
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
                {showCustomize ? t('save') : t('customize')}
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

// 市场行组件 - 使用 memo 防止不必要的重新渲染
const MarketRow = memo(function MarketRow({ data }: { data: MarketRow }) {
  return (
    <Box
      bg="primary"
      p={3}
      radius="lg"
      border="secondary"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        transition: `all ${tokens.transition.base}`,
        contain: 'layout style paint',
        cursor: 'pointer',
        gap: tokens.spacing[2],
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tokens.colors.bg.secondary
        e.currentTarget.style.borderColor = tokens.colors.border.primary
        e.currentTarget.style.transform = 'translateY(-1px)'
        e.currentTarget.style.boxShadow = tokens.shadow.sm
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = tokens.colors.bg.primary
        e.currentTarget.style.borderColor = tokens.colors.border.secondary
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = tokens.shadow.none
      }}
    >
      <Text size="sm" weight="black" style={{ flexShrink: 0 }}>
        {data.symbol.replace('-USD', '')}
      </Text>
      <Box style={{ textAlign: 'right', flexShrink: 0 }}>
        <div
          style={{
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 700,
            marginBottom: tokens.spacing[1],
            color: tokens.colors.text.primary,
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          }}
        >
          ${data.price}
        </div>
        <div
          style={{
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: 700,
            color: data.direction === 'up' ? tokens.colors.accent.success : tokens.colors.accent.error,
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          }}
        >
          {data.changePct}
        </div>
      </Box>
    </Box>
  )
}, (prevProps, nextProps) => {
  // 自定义比较函数：只在价格或百分比真正变化时才重新渲染
  return (
    prevProps.data.symbol === nextProps.data.symbol &&
    prevProps.data.price === nextProps.data.price &&
    prevProps.data.changePct === nextProps.data.changePct &&
    prevProps.data.direction === nextProps.data.direction
  )
})

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
  const { t } = useLanguage()
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
        {t('selectCoinsToDisplay')}
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
          {t('save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </Box>
    </Box>
  )
}
