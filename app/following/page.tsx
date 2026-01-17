'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import EmptyState from '@/app/components/UI/EmptyState'
import Avatar from '@/app/components/UI/Avatar'

// 平台配置
const sourceConfig: Record<string, { label: string; color: string }> = {
  binance: { label: 'Binance', color: '#F0B90B' },
  binance_web3: { label: 'Binance Web3', color: '#F0B90B' },
  bybit: { label: 'Bybit', color: '#F7A600' },
  bitget: { label: 'Bitget', color: '#00C853' },
  okx: { label: 'OKX', color: '#000000' },
  kucoin: { label: 'KuCoin', color: '#23AF91' },
  gate: { label: 'Gate.io', color: '#17E6A1' },
  mexc: { label: 'MEXC', color: '#1972E2' },
  coinex: { label: 'CoinEx', color: '#5799F7' },
}

const getSourceDisplayName = (source: string) => sourceConfig[source]?.label || source
const getSourceColor = (source: string) => sourceConfig[source]?.color || '#888888'

// 统一的关注项类型
type FollowItem = {
  id: string
  handle: string
  type: 'trader' | 'user'
  avatar_url?: string
  bio?: string
  roi?: number
  pnl?: number
  win_rate?: number
  followers?: number
  source?: string
  followed_at?: string
}

export default function FollowingPage() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [items, setItems] = useState<FollowItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      setLoading(true)
      try {
        const response = await fetch(`/api/following?userId=${userId}`)
        const data = await response.json()
        
        if (!response.ok) {
          console.error('Error fetching following:', data.error)
          setItems([])
          return
        }

        setItems(data.items || [])
      } catch (error) {
        console.error('Error loading following:', error)
        setItems([])
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [userId])

  const handleItemClick = (item: FollowItem) => {
    if (item.type === 'trader') {
      router.push(`/trader/${encodeURIComponent(item.handle)}?source=${item.source || 'binance'}`)
    } else {
      router.push(`/u/${encodeURIComponent(item.handle)}`)
    }
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            我的关注
          </Text>
          <EmptyState
            title="请先登录"
            description="登录后可以查看您关注的内容"
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          我的关注
        </Text>
        {loading ? (
          <RankingSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            title="暂无关注"
            description="关注交易员或用户后，他们会显示在这里"
          />
        ) : (
          <Box style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: tokens.spacing[2],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            padding: tokens.spacing[2],
          }}>
            {items.map((item) => (
              <Box
                key={`${item.type}-${item.id}`}
                onClick={() => handleItemClick(item)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  cursor: 'pointer',
                  transition: `background ${tokens.transition.base}`,
                  background: 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                {/* 头像 */}
                <Avatar
                  userId={item.id}
                  name={item.handle}
                  avatarUrl={item.avatar_url}
                  size={48}
                  style={{ flexShrink: 0 }}
                />

                {/* 信息区域 */}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                    <Text size="sm" weight="semibold" style={{ 
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {item.handle}
                    </Text>
                    {/* 类型标签 */}
                    <span style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      borderRadius: tokens.radius.sm,
                      background: item.type === 'trader' 
                        ? getSourceColor(item.source || 'binance') + '20'
                        : tokens.colors.accent.brand + '20',
                      color: item.type === 'trader'
                        ? getSourceColor(item.source || 'binance')
                        : tokens.colors.accent.brand,
                      fontWeight: 500,
                    }}>
                      {item.type === 'trader' 
                        ? getSourceDisplayName(item.source || 'binance')
                        : '用户'}
                    </span>
                  </Box>
                  
                  {/* 交易员显示 ROI，用户显示 bio */}
                  {item.type === 'trader' ? (
                    <Box style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: tokens.spacing[3],
                      marginTop: 4,
                    }}>
                      <Text size="xs" color="tertiary">
                        ROI: <span style={{ 
                          color: (item.roi || 0) >= 0 
                            ? tokens.colors.accent.success 
                            : tokens.colors.accent.error,
                          fontWeight: 500,
                        }}>
                          {(item.roi || 0) >= 0 ? '+' : ''}{((item.roi || 0)).toFixed(2)}%
                        </span>
                      </Text>
                      {item.win_rate !== undefined && (
                        <Text size="xs" color="tertiary">
                          胜率: {(item.win_rate || 0).toFixed(1)}%
                        </Text>
                      )}
                      {item.followers !== undefined && item.followers > 0 && (
                        <Text size="xs" color="tertiary">
                          跟单: {item.followers.toLocaleString()}
                        </Text>
                      )}
                    </Box>
                  ) : item.bio ? (
                    <Text size="xs" color="tertiary" style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginTop: 4,
                    }}>
                      {item.bio}
                    </Text>
                  ) : null}
                </Box>

                {/* 右侧箭头 */}
                <Box style={{ 
                  color: tokens.colors.text.tertiary,
                  flexShrink: 0,
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}








