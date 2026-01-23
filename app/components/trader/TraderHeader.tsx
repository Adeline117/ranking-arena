'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../base'
import ClaimTraderButton from './ClaimTraderButton'
import CopyTradeButton from './CopyTradeButton'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { ProBadgeOverlay } from '../ui/ProBadge'

interface CommunityScore {
  avg_rating: number
  review_count: number
  recommend_rate: number
}

interface TraderHeaderProps {
  handle: string
  traderId: string
  uid?: number // 数字用户编号
  avatarUrl?: string
  coverUrl?: string // 用户背景图片
  isRegistered?: boolean
  followers?: number
  copiers?: number // 跟单人数
  aum?: number // 管理资金量 (USD)
  isOwnProfile?: boolean
  source?: string
  communityScore?: CommunityScore | null
  proBadgeTier?: 'pro' | null // Pro 徽章等级
  isPro?: boolean // 是否为 Pro 用户
  activeSince?: string // 入驻日期
  roi90d?: number // 用于推断交易风格
  maxDrawdown?: number // 最大回撤
  winRate?: number // 胜率
}

// 来源平台配置 - 只显示类型，不显示交易所名称
const sourceConfig: Record<string, { label: string; color: string }> = {
  binance_futures: { label: '合约', color: tokens.colors.text.secondary },
  binance_spot: { label: '现货', color: tokens.colors.text.secondary },
  binance_web3: { label: '链上', color: tokens.colors.text.secondary },
  bybit: { label: '合约', color: tokens.colors.text.secondary },
  bitget_futures: { label: '合约', color: tokens.colors.text.secondary },
  bitget_spot: { label: '现货', color: tokens.colors.text.secondary },
  mexc: { label: '合约', color: tokens.colors.text.secondary },
  coinex: { label: '合约', color: tokens.colors.text.secondary },
  okx_web3: { label: '链上', color: tokens.colors.text.secondary },
  kucoin: { label: '合约', color: tokens.colors.text.secondary },
  gmx: { label: '链上', color: tokens.colors.text.secondary },
}

// 推断交易风格标签
function getTradingStyleTags(source?: string, roi90d?: number, maxDrawdown?: number, winRate?: number): Array<{ label: string; color: string }> {
  const tags: Array<{ label: string; color: string }> = []

  // 基于来源
  if (source?.includes('web3') || source === 'gmx') {
    tags.push({ label: '链上', color: '#8B5CF6' })
  } else if (source?.includes('spot')) {
    tags.push({ label: '现货', color: '#06B6D4' })
  } else if (source?.includes('futures') || source === 'bybit' || source === 'okx') {
    tags.push({ label: '合约', color: '#F59E0B' })
  }

  // 基于指标推断风格
  if (maxDrawdown !== undefined && Math.abs(maxDrawdown) < 10) {
    tags.push({ label: '低回撤', color: '#10B981' })
  }
  if (winRate !== undefined && winRate > 70) {
    tags.push({ label: '高胜率', color: '#22C55E' })
  }
  if (roi90d !== undefined && roi90d > 100) {
    tags.push({ label: '高收益', color: '#EF4444' })
  }

  return tags.slice(0, 3) // 最多3个标签
}

// 格式化 AUM
function formatAum(aum: number): string {
  if (aum >= 1000000) return `$${(aum / 1000000).toFixed(1)}M`
  if (aum >= 1000) return `$${(aum / 1000).toFixed(0)}K`
  return `$${aum.toFixed(0)}`
}

// 计算活跃天数
function getActiveDays(activeSince?: string): number | null {
  if (!activeSince) return null
  const start = new Date(activeSince)
  if (isNaN(start.getTime())) return null
  const now = new Date()
  return Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
}

export default function TraderHeader({
  handle,
  traderId,
  uid,
  avatarUrl,
  coverUrl,
  isRegistered,
  followers = 0,
  copiers,
  aum,
  isOwnProfile = false,
  source,
  communityScore,
  proBadgeTier,
  isPro = false,
  activeSince,
  roi90d,
  maxDrawdown,
  winRate,
}: TraderHeaderProps) {
  const [userId, setUserId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const router = useRouter()

  useEffect(() => {
    setMounted(true)
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  const sourceInfo = source ? sourceConfig[source.toLowerCase()] : null

  return (
    <Box
      className="profile-header"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[6],
        background: coverUrl 
          ? `linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.6) 100%), url(${coverUrl}) center/cover no-repeat`
          : `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}E8 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}50`,
        boxShadow: `0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.05)`,
        position: 'relative',
        overflow: 'visible',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(-20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        minHeight: coverUrl ? 180 : undefined,
      }}
    >
      {/* 背景装饰 - 只在没有自定义背景时显示 */}
      {!coverUrl && (
        <Box style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: tokens.radius.xl, pointerEvents: 'none' }}>
          <Box
            style={{
              position: 'absolute',
              top: -100,
              left: -100,
              width: 300,
              height: 300,
              background: `radial-gradient(circle, ${tokens.colors.accent.primary}08 0%, transparent 70%)`,
            }}
          />
          <Box
            style={{
              position: 'absolute',
              bottom: -80,
              right: -80,
              width: 200,
              height: 200,
              background: `radial-gradient(circle, ${tokens.colors.accent.brand}06 0%, transparent 70%)`,
            }}
          />
        </Box>
      )}
      
      {/* 左侧：Avatar + Handle */}
      <Box
        className="profile-header-info"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[5],
          flex: 1,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Avatar */}
        <Box
          className="profile-header-avatar"
          style={{
            width: 72,
            height: 72,
            borderRadius: tokens.radius.full,
            background: avatarUrl ? tokens.colors.bg.secondary : getAvatarGradient(traderId),
            border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
            display: 'grid',
            placeItems: 'center',
            fontWeight: tokens.typography.fontWeight.black,
            fontSize: tokens.typography.fontSize.xl,
            color: '#ffffff',
            overflow: 'hidden',
            flexShrink: 0,
            boxShadow: avatarHovered 
              ? `0 8px 32px rgba(139, 111, 168, 0.4), 0 0 0 4px ${tokens.colors.accent.primary}20`
              : `0 4px 16px rgba(0, 0, 0, 0.15)`,
            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
            position: 'relative',
            transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
            cursor: 'pointer',
          }}
          onMouseEnter={() => setAvatarHovered(true)}
          onMouseLeave={() => setAvatarHovered(false)}
        >
          {avatarUrl ? (
            <img 
              src={`/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
              alt={handle} 
              loading="lazy"
              style={{ 
                width: '100%', 
                height: '100%', 
                objectFit: 'cover',
                transition: 'all 0.4s ease',
              }}
              onError={(e) => {
                const img = e.target as HTMLImageElement
                img.style.display = 'none'
                const container = img.parentElement
                if (container) {
                  container.style.background = getAvatarGradient(traderId)
                  // 添加备用文字
                  const fallback = document.createElement('span')
                  fallback.textContent = getAvatarInitial(handle)
                  fallback.style.cssText = 'color: #fff; font-size: 32px; font-weight: 900; line-height: 1; text-shadow: 0 2px 8px rgba(0,0,0,0.4);'
                  container.appendChild(fallback)
                }
              }}
            />
          ) : (
            <Text 
              size="2xl" 
              weight="black" 
              style={{ 
                color: '#ffffff',
                textShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
                fontSize: '32px',
                lineHeight: '1',
              }}
            >
              {getAvatarInitial(handle)}
            </Text>
          )}
          {/* Pro 徽章 */}
          {proBadgeTier === 'pro' && (
            <ProBadgeOverlay position="bottom-right" />
          )}
        </Box>

        {/* Info */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[2] }}>
            <Text 
              size="2xl" 
              weight="black" 
              style={{ 
                color: coverUrl ? '#ffffff' : tokens.colors.text.primary,
                lineHeight: tokens.typography.lineHeight.tight,
                textShadow: coverUrl ? '0 2px 8px rgba(0,0,0,0.5)' : undefined,
              }}
            >
              {handle}
            </Text>
            
            {/* UID Badge */}
            {uid && (
              <Box
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: `3px ${tokens.spacing[2]}`,
                  background: `${tokens.colors.accent.primary}15`,
                  borderRadius: tokens.radius.full,
                  border: `1px solid ${tokens.colors.accent.primary}30`,
                }}
                title="用户编号"
              >
                <Text 
                  size="xs" 
                  weight="bold" 
                  style={{ 
                    color: tokens.colors.accent.primary,
                    fontFamily: 'monospace',
                    letterSpacing: '0.5px',
                  }}
                >
                  #{uid.toString().padStart(6, '0')}
                </Text>
              </Box>
            )}
            
            {/* Source Badge */}
            {sourceInfo && (
              <Box
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: `4px ${tokens.spacing[3]}`,
                  background: `${sourceInfo.color}18`,
                  borderRadius: tokens.radius.full,
                  border: `1px solid ${sourceInfo.color}40`,
                }}
              >
                <Text 
                  size="xs" 
                  weight="bold" 
                  style={{ 
                    color: sourceInfo.color,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                >
                  {sourceInfo.label}
                </Text>
              </Box>
            )}
            
            {/* Verified Badge for Registered Users */}
            {isRegistered && (
              <Box
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  background: `linear-gradient(135deg, ${tokens.colors.accent.success}, #00D4AA)`,
                  borderRadius: tokens.radius.full,
                  boxShadow: `0 2px 8px ${tokens.colors.accent.success}40`,
                }}
                title="已认证用户"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </Box>
            )}
            
            {/* Community Score Badge */}
            {communityScore && communityScore.review_count > 0 && (
              <Box
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: tokens.spacing[1],
                  padding: `4px ${tokens.spacing[3]}`,
                  background: `rgba(255, 215, 0, 0.12)`,
                  borderRadius: tokens.radius.full,
                  border: `1px solid rgba(255, 215, 0, 0.3)`,
                }}
                title={`${communityScore.review_count} 条用户评价`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#FFD700" stroke="#FFD700" strokeWidth="1">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <Text 
                  size="xs" 
                  weight="bold" 
                  style={{ 
                    color: '#FFD700',
                  }}
                >
                  {communityScore.avg_rating.toFixed(1)}
                </Text>
                <Text 
                  size="xs" 
                  style={{ 
                    color: 'rgba(255, 215, 0, 0.7)',
                  }}
                >
                  ({communityScore.review_count})
                </Text>
              </Box>
            )}
          </Box>
          
          {/* 统计指标行 */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], flexWrap: 'wrap' }}>
            {/* 粉丝 */}
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.md,
              }}
            >
              <Text
                size="sm"
                style={{
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color: coverUrl ? 'rgba(255,255,255,0.8)' : tokens.colors.text.secondary,
                  textShadow: coverUrl ? '0 1px 4px rgba(0,0,0,0.5)' : undefined,
                }}
              >
                <Text
                  as="span"
                  weight="black"
                  style={{
                    color: coverUrl ? '#ffffff' : tokens.colors.text.primary,
                    marginRight: 4,
                    textShadow: coverUrl ? '0 1px 4px rgba(0,0,0,0.5)' : undefined,
                  }}
                >
                  {followers.toLocaleString()}
                </Text>
                粉丝
              </Text>
            </Box>

            {/* 跟单人数 */}
            {copiers !== undefined && copiers > 0 && (
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  borderRadius: tokens.radius.md,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={coverUrl ? 'rgba(255,255,255,0.7)' : tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <Text
                  size="sm"
                  style={{
                    color: coverUrl ? 'rgba(255,255,255,0.8)' : tokens.colors.text.secondary,
                    textShadow: coverUrl ? '0 1px 4px rgba(0,0,0,0.5)' : undefined,
                  }}
                >
                  <Text as="span" weight="black" style={{ color: coverUrl ? '#ffffff' : tokens.colors.text.primary, marginRight: 4 }}>
                    {copiers.toLocaleString()}
                  </Text>
                  跟单
                </Text>
              </Box>
            )}

            {/* AUM */}
            {aum !== undefined && aum > 0 && (
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  borderRadius: tokens.radius.md,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={coverUrl ? 'rgba(255,255,255,0.7)' : tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="1" x2="12" y2="23" />
                  <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
                <Text
                  size="sm"
                  style={{
                    color: coverUrl ? 'rgba(255,255,255,0.8)' : tokens.colors.text.secondary,
                    textShadow: coverUrl ? '0 1px 4px rgba(0,0,0,0.5)' : undefined,
                  }}
                >
                  <Text as="span" weight="bold" style={{ color: coverUrl ? '#ffffff' : tokens.colors.text.primary, marginRight: 4 }}>
                    {formatAum(aum)}
                  </Text>
                  AUM
                </Text>
              </Box>
            )}

            {/* 活跃天数 - 信任信号 */}
            {(() => {
              const days = getActiveDays(activeSince)
              if (!days || days < 7) return null
              return (
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={coverUrl ? 'rgba(255,255,255,0.7)' : tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <Text
                    size="sm"
                    style={{
                      color: coverUrl ? 'rgba(255,255,255,0.8)' : tokens.colors.text.secondary,
                      textShadow: coverUrl ? '0 1px 4px rgba(0,0,0,0.5)' : undefined,
                    }}
                  >
                    <Text as="span" weight="bold" style={{ color: coverUrl ? '#ffffff' : tokens.colors.text.primary, marginRight: 4 }}>
                      {days > 365 ? `${Math.floor(days / 365)}年` : `${days}天`}
                    </Text>
                    活跃
                  </Text>
                </Box>
              )
            })()}
          </Box>

          {/* 交易风格标签 */}
          {(() => {
            const tags = getTradingStyleTags(source, roi90d, maxDrawdown, winRate)
            if (tags.length === 0) return null
            return (
              <Box style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {tags.map((tag, i) => (
                  <Box
                    key={i}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '2px 8px',
                      borderRadius: tokens.radius.full,
                      background: `${tag.color}15`,
                      border: `1px solid ${tag.color}30`,
                    }}
                  >
                    <Text style={{ fontSize: 10, fontWeight: 600, color: tag.color }}>
                      {tag.label}
                    </Text>
                  </Box>
                ))}
              </Box>
            )
          })()}
        </Box>
      </Box>

      {/* 右侧：Buttons */}
      <Box
        className="profile-header-actions action-buttons"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          flexShrink: 0,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* 编辑资料按钮 - 仅自己的主页显示 */}
        {isOwnProfile && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/settings')}
            style={{
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.lg,
              background: `${tokens.colors.accent.primary}15`,
              border: `1px solid ${tokens.colors.accent.primary}40`,
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `${tokens.colors.accent.primary}25`
              e.currentTarget.style.borderColor = tokens.colors.accent.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = `${tokens.colors.accent.primary}15`
              e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}40`
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            编辑资料
          </Button>
        )}

        {/* 跟单按钮 - 最重要的 CTA */}
        {isPro ? (
          <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <CopyTradeButton
              traderId={traderId}
              source={source}
              traderHandle={handle}
            />
            <Text size="xs" color="tertiary" style={{ fontSize: 10, opacity: 0.7 }}>
              跳转至交易所跟单
            </Text>
          </Box>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/pricing')}
              style={{
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg,
                background: `${tokens.colors.bg.tertiary}`,
                border: `1px solid ${tokens.colors.border.primary}`,
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                opacity: 0.7,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              跟单 Pro
            </Button>
            <Text size="xs" color="tertiary" style={{ fontSize: 10, opacity: 0.7 }}>
              解锁后跳转交易所跟单
            </Text>
          </Box>
        )}

        {/* 返回按钮 */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/')}
          style={{
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.lg,
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.secondary
            e.currentTarget.style.borderColor = tokens.colors.accent.primary + '40'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.tertiary
            e.currentTarget.style.borderColor = tokens.colors.border.primary
          }}
        >
          ← 返回
        </Button>

        
        {!isOwnProfile && !isRegistered && userId && (
          <ClaimTraderButton traderId={traderId} handle={handle} userId={userId} source={source} />
        )}
      </Box>
    </Box>
  )
}
