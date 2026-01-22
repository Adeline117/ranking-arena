'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import TraderComparison from '@/app/components/premium/TraderComparison'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

interface TraderCompareData {
  id: string
  handle: string | null
  source: string
  roi: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  max_drawdown?: number
  win_rate?: number
  trades_count?: number
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
  avatar_url?: string
  followers?: number
}

function CompareContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useLanguage()
  const { showToast } = useToast()
  
  const [email, setEmail] = useState<string | null>(null)
  const [_userId, setUserId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [traders, setTraders] = useState<TraderCompareData[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [isPro, setIsPro] = useState(false)

  // 获取用户信息
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setUserId(data.session?.user?.id ?? null)
      setAccessToken(data.session?.access_token ?? null)
      
      if (!data.session) {
        router.push('/login?redirect=/compare')
      }
    })
  }, [router])

  // 检查 Pro 权限并加载初始数据
  useEffect(() => {
    if (!accessToken) return

    const init = async () => {
      try {
        // 检查订阅
        const subRes = await fetch('/api/subscription', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (subRes.ok) {
          const subData = await subRes.json()
          const tier = subData.subscription?.tier || 'free'
          setIsPro(tier === 'pro')
        }

        // 从 URL 获取初始交易员 ID
        const ids = searchParams.get('ids')
        if (ids) {
          await loadTraders(ids.split(','))
        }
      } catch (err) {
        console.error('初始化失败:', err)
      } finally {
        setLoading(false)
      }
    }

    init()
  }, [accessToken, searchParams])

  // 加载交易员数据
  const loadTraders = async (traderIds: string[]) => {
    if (!accessToken || traderIds.length === 0) return

    try {
      const res = await fetch(`/api/compare?ids=${traderIds.join(',')}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!res.ok) {
        const data = await res.json()
        if (res.status === 403) {
          setError('此功能需要 Pro 会员')
        } else {
          setError(data.error || '加载失败')
        }
        return
      }

      const data = await res.json()
      setTraders(data.traders || [])
      setError(null)
    } catch (err) {
      console.error('加载交易员数据失败:', err)
      setError('网络错误')
    }
  }

  // 搜索交易员
  const handleSearch = async () => {
    if (!searchInput.trim()) return

    setSearching(true)
    try {
      const { data, error } = await supabase
        .from('trader_sources')
        .select('source_trader_id, source, roi, arena_score, avatar_url')
        .or(`source_trader_id.ilike.%${searchInput}%`)
        .order('arena_score', { ascending: false, nullsFirst: false })
        .limit(10)

      if (error) throw error
      setSearchResults(data || [])
    } catch (err) {
      console.error('搜索失败:', err)
    } finally {
      setSearching(false)
    }
  }

  // 添加交易员到对比
  const handleAddTrader = async (traderId: string) => {
    if (traders.length >= 5) {
      showToast('最多只能对比 5 位交易员', 'warning')
      return
    }
    if (traders.some(t => t.id === traderId)) {
      showToast('该交易员已在对比列表中', 'warning')
      return
    }

    const newIds = [...traders.map(t => t.id), traderId]
    await loadTraders(newIds)
    
    // 更新 URL
    router.replace(`/compare?ids=${newIds.join(',')}`, { scroll: false })
    
    // 清空搜索
    setSearchInput('')
    setSearchResults([])
  }

  // 移除交易员
  const handleRemoveTrader = (traderId: string) => {
    const newTraders = traders.filter(t => t.id !== traderId)
    setTraders(newTraders)
    
    // 更新 URL
    if (newTraders.length > 0) {
      router.replace(`/compare?ids=${newTraders.map(t => t.id).join(',')}`, { scroll: false })
    } else {
      router.replace('/compare', { scroll: false })
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="lg" color="tertiary">加载中...</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      {/* Background mesh */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: `radial-gradient(ellipse at 20% 20%, ${tokens.colors.accent.primary}08 0%, transparent 50%),
                       radial-gradient(ellipse at 80% 80%, ${tokens.colors.accent.brand}06 0%, transparent 50%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], position: 'relative', zIndex: 1 }}>
        {/* 标题 */}
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" className="gradient-text">
            交易员对比
          </Text>
          <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            最多可对比 5 位交易员，快速比较各项指标
          </Text>
        </Box>

        {/* Pro 权限检查 */}
        {!isPro && (
          <Box
            style={{
              padding: tokens.spacing[6],
              background: 'var(--color-pro-glow)',
              borderRadius: tokens.radius.xl,
              border: '1px solid var(--color-pro-gradient-start)',
              marginBottom: tokens.spacing[6],
              textAlign: 'center',
            }}
          >
            <Box
              style={{
                width: 48,
                height: 48,
                borderRadius: tokens.radius.lg,
                background: 'var(--color-blur-overlay)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
                marginBottom: tokens.spacing[3],
              }}
            >
              <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="var(--color-pro-gradient-start)" strokeWidth="2">
                <path d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z" />
                <path d="M7 11V7C7 4.2 9.2 2 12 2C14.8 2 17 4.2 17 7V11" strokeLinecap="round" />
              </svg>
            </Box>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('proRequired')}
            </Text>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('featureTraderCompareDesc')}
            </Text>
            <Button
              variant="primary"
              onClick={() => router.push('/pricing')}
              style={{
                background: 'var(--color-pro-badge-bg)',
                border: 'none',
                boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
              }}
            >
              {t('upgradeToPro')}
            </Button>
          </Box>
        )}

        {/* 错误提示 */}
        {error && (
          <Box
            style={{
              padding: tokens.spacing[4],
              background: `${tokens.colors.accent.error}15`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.accent.error}30`,
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="sm" style={{ color: tokens.colors.accent.error }}>
              {error}
            </Text>
          </Box>
        )}

        {/* 搜索添加交易员 */}
        {isPro && (
          <Box
            style={{
              marginBottom: tokens.spacing[6],
              padding: tokens.spacing[4],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              添加交易员 ({traders.length}/5)
            </Text>
            
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="输入交易员 ID 搜索..."
                style={{
                  flex: 1,
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
              <Button
                variant="secondary"
                onClick={handleSearch}
                disabled={searching || !searchInput.trim()}
              >
                {searching ? '搜索中...' : '搜索'}
              </Button>
            </Box>

            {/* 搜索结果 */}
            {searchResults.length > 0 && (
              <Box
                style={{
                  marginTop: tokens.spacing[3],
                  maxHeight: 300,
                  overflowY: 'auto',
                  background: tokens.colors.bg.primary,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                {searchResults.map((result) => (
                  <Box
                    key={`${result.source_trader_id}-${result.source}`}
                    onClick={() => handleAddTrader(result.source_trader_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: tokens.spacing[3],
                      cursor: 'pointer',
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                      transition: 'background 0.2s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = tokens.colors.bg.secondary}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <Box>
                      <Text size="sm" weight="semibold">
                        {result.source_trader_id.length > 20 
                          ? `${result.source_trader_id.slice(0, 8)}...${result.source_trader_id.slice(-6)}`
                          : result.source_trader_id}
                      </Text>
                      <Text size="xs" color="tertiary">{result.source}</Text>
                    </Box>
                    <Box style={{ textAlign: 'right' }}>
                      <Text
                        size="sm"
                        weight="bold"
                        style={{ color: result.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}
                      >
                        {result.roi >= 0 ? '+' : ''}{result.roi?.toFixed(2)}%
                      </Text>
                      {result.arena_score && (
                        <Text size="xs" color="secondary">
                          Score: {result.arena_score.toFixed(1)}
                        </Text>
                      )}
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}

        {/* 对比表格 */}
        {isPro && (
          <TraderComparison
            traders={traders}
            onRemove={handleRemoveTrader}
            showRemoveButton={true}
          />
        )}
      </Box>
    </Box>
  )
}

export default function ComparePage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#888' }}>加载中...</Text>
      </Box>
    }>
      <CompareContent />
    </Suspense>
  )
}
