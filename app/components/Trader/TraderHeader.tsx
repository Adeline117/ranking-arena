'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../Base'
import ClaimTraderButton from './ClaimTraderButton'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { ProBadgeOverlay } from '../UI/ProBadge'

/**
 * 根据交易所来源和交易员ID生成原网页链接
 */
function getOriginalUrl(source: string | undefined, traderId: string): string | null {
  if (!source) return null
  
  const urlMap: Record<string, string> = {
    binance_futures: `https://www.binance.com/en/copy-trading/lead-details/${traderId}`,
    binance_spot: `https://www.binance.com/en/copy-trading/lead-details/${traderId}`,
    binance_web3: `https://www.binance.com/en/copy-trading/lead-details/${traderId}`,
    binance: `https://www.binance.com/en/copy-trading/lead-details/${traderId}`,
    bybit: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${traderId}`,
    bitget_futures: `https://www.bitget.com/copy-trading/trader?id=${traderId}`,
    bitget_spot: `https://www.bitget.com/copy-trading/trader?id=${traderId}`,
    mexc: `https://futures.mexc.com/exchange/copy-trading/trader/${traderId}`,
    coinex: `https://www.coinex.com/futures/copy-trading/trader/${traderId}`,
    okx_web3: `https://www.okx.com/web3/copy-trading/trader/${traderId}`,
    kucoin: `https://www.kucoin.com/copy-trading/trader/${traderId}`,
    gmx: `https://app.gmx.io/#/leaderboard/${traderId}`,
  }
  
  return urlMap[source.toLowerCase()] || null
}

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
  isOwnProfile?: boolean
  source?: string
  communityScore?: CommunityScore | null
  proBadgeTier?: 'pro' | null // Pro 徽章等级
}

// 来源平台配置 - 统一颜色，不做颜色区分
const sourceConfig: Record<string, { label: string; color: string }> = {
  binance_futures: { label: 'Binance 合约', color: tokens.colors.text.secondary },
  binance_spot: { label: 'Binance 现货', color: tokens.colors.text.secondary },
  binance_web3: { label: 'Binance 链上', color: tokens.colors.text.secondary },
  bybit: { label: 'Bybit 合约', color: tokens.colors.text.secondary },
  bitget_futures: { label: 'Bitget 合约', color: tokens.colors.text.secondary },
  bitget_spot: { label: 'Bitget 现货', color: tokens.colors.text.secondary },
  mexc: { label: 'MEXC 合约', color: tokens.colors.text.secondary },
  coinex: { label: 'CoinEx 合约', color: tokens.colors.text.secondary },
  okx_web3: { label: 'OKX 链上', color: tokens.colors.text.secondary },
  kucoin: { label: 'KuCoin 合约', color: tokens.colors.text.secondary },
  gmx: { label: 'GMX 链上', color: tokens.colors.text.secondary },
}

export default function TraderHeader({ 
  handle, 
  traderId, 
  uid,
  avatarUrl, 
  coverUrl,
  isRegistered, 
  followers = 0, 
  isOwnProfile = false, 
  source,
  communityScore,
  proBadgeTier,
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
        overflow: 'hidden',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(-20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        minHeight: coverUrl ? 180 : undefined,
      }}
    >
      {/* 背景装饰 - 只在没有自定义背景时显示 */}
      {!coverUrl && (
        <>
          <Box
            style={{
              position: 'absolute',
              top: -100,
              left: -100,
              width: 300,
              height: 300,
              background: `radial-gradient(circle, ${tokens.colors.accent.primary}08 0%, transparent 70%)`,
              pointerEvents: 'none',
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
              pointerEvents: 'none',
            }}
          />
        </>
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
          
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
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
          </Box>
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
        
        {/* 查看原网页按钮 */}
        {(() => {
          const originalUrl = getOriginalUrl(source, traderId)
          return originalUrl ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(originalUrl, '_blank', 'noopener,noreferrer')}
              style={{
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg,
                background: `${tokens.colors.accent.primary}10`,
                border: `1px solid ${tokens.colors.accent.primary}30`,
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${tokens.colors.accent.primary}20`
                e.currentTarget.style.borderColor = tokens.colors.accent.primary
                e.currentTarget.style.color = tokens.colors.accent.primary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `${tokens.colors.accent.primary}10`
                e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}30`
                e.currentTarget.style.color = tokens.colors.text.secondary
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              查看原网页
            </Button>
          ) : null
        })()}
        
        {!isOwnProfile && !isRegistered && userId && (
          <ClaimTraderButton traderId={traderId} handle={handle} userId={userId} source={source} />
        )}
      </Box>
    </Box>
  )
}
