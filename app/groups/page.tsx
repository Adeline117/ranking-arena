'use client'

import Link from 'next/link'
import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import RankingTableCompact from '@/app/components/Features/RankingTableCompact'
import PostFeed from '@/app/components/Features/PostFeed'
import Card from '@/app/components/UI/Card'
import { Box, Text, Button } from '@/app/components/Base'
import type { Trader } from '@/app/components/Features/RankingTable'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import { useToast } from '@/app/components/UI/Toast'

type Group = {
  id: string
  name: string
  avatar_url?: string | null
  member_count?: number | null
}

function GroupsList() {
  const { language } = useLanguage()
  const { showToast } = useToast()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        setError(null)
        const { data, error: supabaseError } = await supabase
          .from('groups')
          .select('id, name, avatar_url, member_count')
          .order('member_count', { ascending: false, nullsFirst: false })
          .limit(10)

        if (supabaseError) {
          const errorMsg = language === 'zh' 
            ? '加载小组列表失败，请稍后重试' 
            : 'Failed to load groups, please try again later'
          setError(errorMsg)
          showToast(errorMsg, 'error')
          console.error('Error loading groups:', JSON.stringify(supabaseError))
        }
        setGroups(data || [])
      } catch (err) {
        const errorMsg = language === 'zh'
          ? '网络错误，请检查网络连接后重试'
          : 'Network error, please check your connection and try again'
        setError(errorMsg)
        showToast(errorMsg, 'error')
        console.error('Error loading groups:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [language, showToast])

  if (loading) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {language === 'zh' ? '加载中...' : 'Loading...'}
      </Text>
    )
  }

  if (error) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="sm" style={{ color: '#DC2626', marginBottom: tokens.spacing[2] }}>
          {error}
        </Text>
        <Button 
          variant="secondary" 
          size="sm"
          onClick={() => {
            setLoading(true)
            setError(null)
            const load = async () => {
              try {
                const { data, error: supabaseError } = await supabase
                  .from('groups')
                  .select('id, name, avatar_url, member_count')
                  .order('member_count', { ascending: false, nullsFirst: false })
                  .limit(10)
                if (supabaseError) {
                  const errorMsg = language === 'zh' 
                    ? '加载小组列表失败，请稍后重试' 
                    : 'Failed to load groups, please try again later'
                  setError(errorMsg)
                  showToast(errorMsg, 'error')
                } else {
                  setGroups(data || [])
                }
              } catch (err) {
                const errorMsg = language === 'zh'
                  ? '网络错误，请检查网络连接后重试'
                  : 'Network error, please check your connection and try again'
                setError(errorMsg)
                showToast(errorMsg, 'error')
              } finally {
                setLoading(false)
              }
            }
            load()
          }}
        >
          {language === 'zh' ? '重试' : 'Retry'}
        </Button>
      </Box>
    )
  }

  if (groups.length === 0) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {language === 'zh' ? '暂无小组' : 'No groups available'}
      </Text>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {groups.map((group, idx) => {
        const isHovered = hoveredGroup === group.id
        return (
          <Link
            key={group.id}
            href={`/groups/${group.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              background: isHovered 
                ? 'linear-gradient(135deg, rgba(139, 111, 168, 0.12) 0%, rgba(139, 111, 168, 0.05) 100%)'
                : tokens.colors.bg.secondary,
              border: `1px solid ${isHovered ? 'rgba(139, 111, 168, 0.3)' : tokens.colors.border.primary}`,
              textDecoration: 'none',
              color: tokens.colors.text.primary,
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              cursor: 'pointer',
              transform: isHovered ? 'translateX(6px) scale(1.02)' : 'translateX(0) scale(1)',
              boxShadow: isHovered ? '0 8px 24px rgba(139, 111, 168, 0.15)' : 'none',
              position: 'relative',
              overflow: 'hidden',
            }}
            onMouseEnter={() => setHoveredGroup(group.id)}
            onMouseLeave={() => setHoveredGroup(null)}
          >
            {/* Hover glow effect */}
            {isHovered && (
              <Box
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: 'linear-gradient(90deg, transparent 0%, rgba(139, 111, 168, 0.08) 50%, transparent 100%)',
                  pointerEvents: 'none',
                }}
              />
            )}
            
            {/* Avatar */}
            <Box
              style={{
                width: 44,
                height: 44,
                borderRadius: tokens.radius.lg,
                background: `linear-gradient(135deg, rgba(139, 111, 168, 0.2) 0%, rgba(139, 111, 168, 0.1) 100%)`,
                border: isHovered 
                  ? '2px solid rgba(139, 111, 168, 0.4)'
                  : `1px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
                transition: 'all 0.25s ease',
                transform: isHovered ? 'scale(1.08)' : 'scale(1)',
                boxShadow: isHovered ? '0 4px 12px rgba(139, 111, 168, 0.2)' : 'none',
              }}
            >
              {group.avatar_url ? (
                <img
                  src={group.avatar_url}
                  alt={group.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <Text size="md" weight="bold" style={{ color: '#c9b8db' }}>
                  {group.name.charAt(0).toUpperCase()}
                </Text>
              )}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0, position: 'relative', zIndex: 1 }}>
              <Text 
                size="sm" 
                weight="bold" 
                style={{ 
                  marginBottom: tokens.spacing[1],
                  color: isHovered ? '#c9b8db' : tokens.colors.text.primary,
                  transition: 'color 0.2s ease',
                }}
              >
                {group.name}
              </Text>
              {group.member_count !== null && group.member_count !== undefined && (
                <Text size="xs" color="tertiary" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ 
                    display: 'inline-block', 
                    width: 6, 
                    height: 6, 
                    borderRadius: '50%', 
                    background: isHovered ? '#8b6fa8' : tokens.colors.text.tertiary,
                    transition: 'background 0.2s ease',
                  }} />
                  {group.member_count} {language === 'zh' ? '位成员' : 'members'}
                </Text>
              )}
            </Box>
            
            {/* Arrow indicator on hover */}
            <Box
              style={{
                opacity: isHovered ? 1 : 0,
                transform: isHovered ? 'translateX(0)' : 'translateX(-8px)',
                transition: 'all 0.25s ease',
                color: '#8b6fa8',
                fontSize: 16,
              }}
            >
              →
            </Box>
          </Link>
        )
      })}
    </Box>
  )
}

function GroupsContent() {
  const { t } = useLanguage()
  const searchParams = useSearchParams()
  const initialPostId = searchParams.get('post')
  const [email, setEmail] = useState<string | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setLoggedIn(!!data.user)
    })
  }, [])

  // 加载交易员数据 - 使用统一的 API
  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const response = await fetch('/api/traders?timeRange=90D')
        const json = await response.json()
        
        // API 返回格式是 { traders: [...] }
        const tradersData = json.traders || json.data || []
        if (tradersData.length > 0) {
          // 取前10名
          const top10 = tradersData.slice(0, 10).map((item: any) => ({
            id: item.id || item.source_trader_id,
            handle: item.handle || item.source_trader_id,
            roi: item.roi || 0,
            pnl: item.pnl || 0,
            win_rate: item.win_rate || 0,
            max_drawdown: item.max_drawdown,
            followers: item.followers || 0,
            source: item.source || 'binance',
          }))
          setTraders(top10)
        } else {
          setTraders([])
        }
      } catch (error) {
        console.error('加载排行榜失败:', error)
        // 排行榜加载失败不影响页面，静默处理
        setTraders([])
      } finally {
        setLoadingTraders(false)
      }
    }
    load()
  }, [])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        {/* 响应式三栏布局 */}
        <style jsx global>{`
          .groups-page-grid {
            display: grid;
            gap: 16px;
            grid-template-columns: 1fr;
          }
          @media (min-width: 768px) {
            .groups-page-grid {
              grid-template-columns: 1fr 280px;
            }
            .groups-page-grid .left-sidebar {
              display: none;
            }
          }
          @media (min-width: 1024px) {
            .groups-page-grid {
              grid-template-columns: 260px 1fr 280px;
            }
            .groups-page-grid .left-sidebar {
              display: block;
            }
          }
          @media (max-width: 767px) {
            .groups-page-grid .right-sidebar {
              order: -1;
            }
          }
        `}</style>
        <Box className="groups-page-grid">
          {/* 左：排名前十 - 仅桌面端显示 */}
          <Box as="section" className="left-sidebar">
            <Card title={t('top10')}>
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={loggedIn} />
            </Card>
          </Box>

          {/* 中：算法推荐帖子 */}
          <Box as="section" className="main-content">
            <Card title={t('recommendedPosts')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {loggedIn ? t('loggedInShowAll') : t('notLoggedInShowLimited')}
              </Text>
              <PostFeed variant={loggedIn ? 'full' : 'compact'} initialPostId={initialPostId} />
            </Card>
          </Box>

          {/* 右：小组推荐 */}
          <Box as="section" className="right-sidebar" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {/* 小组推荐 */}
            <Card title={t('groupRecommendations')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {t('hotGroups')}
              </Text>
              <GroupsList />
              
              {/* 申请创办小组按钮 */}
              <Link href="/groups/apply" style={{ display: 'block', marginTop: tokens.spacing[4] }}>
                <Button
                  variant="secondary"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderRadius: tokens.radius.lg,
                    border: `1px dashed ${tokens.colors.border.primary}`,
                    background: 'transparent',
                    color: tokens.colors.text.secondary,
                    cursor: 'pointer',
                    transition: `all ${tokens.transition.base}`,
                  }}
                >
                  <span style={{ fontSize: '18px' }}>+</span>
                  {t('applyCreateGroup')}
                </Button>
              </Link>
            </Card>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default function GroupsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <GroupsContent />
    </Suspense>
  )
}
