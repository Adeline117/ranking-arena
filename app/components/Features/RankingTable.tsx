'use client'

import { useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../UI/Skeleton'
import { RankingBadge } from '../Icons'
import { Box, Text } from '../Base'
import { useLanguage } from '../Utils/LanguageProvider'
import { getAvatarFallbackGradient, getAvatarInitial } from '@/lib/utils/avatar'

// 格式化 PnL 显示
function formatPnL(pnl: number): string {
  const absPnL = Math.abs(pnl)
  if (absPnL >= 1000000) {
    return `$${(pnl / 1000000).toFixed(2)}M`
  } else if (absPnL >= 1000) {
    return `$${(pnl / 1000).toFixed(2)}K`
  } else {
    return `$${pnl.toFixed(2)}`
  }
}

// 格式化金额（Volume, Avg Buy）
function formatAmount(amount: number): string {
  const absAmount = Math.abs(amount)
  if (absAmount >= 1000000) {
    return `$${(amount / 1000000).toFixed(2)}M`
  } else if (absAmount >= 1000) {
    return `$${(amount / 1000).toFixed(2)}K`
  } else {
    return `$${amount.toFixed(2)}`
  }
}

export interface Trader {
  id: string
  handle: string | null
  roi: number // 90天ROI（固定）
  pnl?: number // 盈亏金额
  win_rate: number // 90天胜率
  volume_90d?: number // 90天交易量
  avg_buy_90d?: number // 90天平均买入
  followers: number
  source?: string // 数据来源：binance, bybit, okx等
  avatar_url?: string // 头像URL
}

/**
 * 排行榜页面 - 极度克制，只解决"谁最强"的问题
 * 只保留：排名、交易员ID、90天ROI、胜率、交易量、平均买入
 */
export default function RankingTable(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
  source?: string // 数据来源
}) {
  const { traders, loading, source } = props
  const { t } = useLanguage()
  
  // 分页状态
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 20 // 每页显示 20 条

  // 按90天ROI排序（固定）
  const sortedTraders = [...traders].sort((a, b) => b.roi - a.roi)
  
  // 计算分页
  const totalPages = Math.ceil(sortedTraders.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const paginatedTraders = sortedTraders.slice(startIndex, endIndex)
  
          // 数据来源标签映射
          const sourceLabels: Record<string, string> = {
            'binance': 'Binance',
            'binance_web3': 'Binance Web3',
            'bybit': 'Bybit',
            'bitget': 'Bitget',
            'mexc': 'MEXC',
            'coinex': 'CoinEx',
            'okx': 'OKX',
          }
  
  const sourceLabel = source ? sourceLabels[source] || source : t('unknownSource')

  return (
    <Box
      bg="secondary"
      p={0}
      radius="lg"
      border="primary"
      style={{
        boxShadow: tokens.shadow.md,
        overflow: 'hidden',
      }}
    >
      {/* Header - 优化UI */}
      <Box
        className="ranking-table-header ranking-table-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '60px 1fr 120px 80px 100px 100px', // Rank | ID | ROI (90D) | Win Rate (90D) | Volume (90D) | Avg Buy (90D)
          gap: tokens.spacing[4],
          padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
          borderBottom: `2px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.secondary,
          borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
          boxShadow: tokens.shadow.xs,
        }}
      >
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('rank')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('trader')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('roi90d')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('winRate90d')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('volume90d')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('avgBuy90d')}
        </Text>
      </Box>

      {loading ? (
        <RankingSkeleton />
      ) : sortedTraders.length === 0 ? (
        <Box
          style={{
            color: tokens.colors.text.tertiary,
            padding: `${tokens.spacing[10]} ${tokens.spacing[3]}`,
            textAlign: 'center',
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {t('noTraderData')}
        </Box>
      ) : (
        <>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {paginatedTraders.map((t, idx) => {
              const rank = startIndex + idx + 1 // 全局排名
              const traderHandle = t.handle || t.id
              const href = `/trader/${encodeURIComponent(traderHandle)}`
              // 使用组合 key 确保唯一性：id + source + index
              const uniqueKey = `${t.id}-${t.source || 'unknown'}-${startIndex + idx}`
              
              // 格式化显示名称：如果是钱包地址（以0x开头且长度>20），则截断
              const formatDisplayName = (name: string) => {
                // 判断是否是钱包地址（0x开头，长度>20）
                if (name.startsWith('0x') && name.length > 20) {
                  return `${name.substring(0, 6)}...${name.substring(name.length - 4)}`
                }
                return name
              }
              
              const displayName = formatDisplayName(traderHandle)
              const sourceLabelText = t.source ? (sourceLabels[t.source] || t.source) : sourceLabel

              const ariaLabel = `排名 ${rank}，交易员 ${displayName}，90天ROI ${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(2)}%，胜率 ${(t.win_rate * 100).toFixed(1)}%，粉丝 ${t.followers.toLocaleString()}`
              
              return (
                <Link
                  key={uniqueKey}
                  href={href}
                  style={{ textDecoration: 'none' }}
                  aria-label={ariaLabel}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      window.location.href = href
                    }
                  }}
                >
                  <Box
                    className="ranking-table-grid"
                    role="row"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '60px 1fr 120px 80px 100px 100px',
                      alignItems: 'center',
                      gap: tokens.spacing[4],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                      cursor: 'pointer',
                      background: rank <= 3 ? `${tokens.colors.bg.secondary}80` : tokens.colors.bg.primary,
                      transition: `all ${tokens.transition.base}`,
                      borderRadius: tokens.radius.none,
                      position: 'relative',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.tertiary || tokens.colors.bg.hover || `${tokens.colors.bg.secondary}CC`
                      e.currentTarget.style.transform = 'translateX(4px)'
                      e.currentTarget.style.boxShadow = tokens.shadow.sm
                      e.currentTarget.style.borderLeft = `3px solid ${tokens.colors.accent.primary}`
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = rank <= 3 ? `${tokens.colors.bg.secondary}80` : tokens.colors.bg.primary
                      e.currentTarget.style.transform = 'translateX(0)'
                      e.currentTarget.style.boxShadow = tokens.shadow.none
                      e.currentTarget.style.borderLeft = 'none'
                    }}
                  >
                    {/* 排名 */}
                    <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {rank <= 3 ? (
                        <RankingBadge rank={rank as 1 | 2 | 3} size={24} />
                      ) : (
                        <Text size="sm" weight="bold" color="tertiary">
                          #{rank}
                        </Text>
                      )}
                    </Box>

                  {/* 交易员ID - 唯一可点击的元素，视觉权重最高 */}
                  <Box style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'nowrap' }}>
                    {/* 头像 - 放在名字左边，优化UI */}
                    <Box
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: tokens.radius.full,
                        background: t.avatar_url ? tokens.colors.bg.secondary : getAvatarFallbackGradient(t.id),
                        border: `1.5px solid ${tokens.colors.border.primary}`,
                        display: 'grid',
                        placeItems: 'center',
                        fontWeight: tokens.typography.fontWeight.black,
                        fontSize: tokens.typography.fontSize.xs,
                        color: '#ffffff',
                        overflow: 'hidden',
                        flexShrink: 0,
                        boxShadow: tokens.shadow.sm,
                        transition: `all ${tokens.transition.base}`,
                        cursor: 'pointer',
                        position: 'relative',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'scale(1.08)'
                        e.currentTarget.style.boxShadow = tokens.shadow.md
                        e.currentTarget.style.borderColor = tokens.colors.accent.primary
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)'
                        e.currentTarget.style.boxShadow = tokens.shadow.sm
                        e.currentTarget.style.borderColor = tokens.colors.border.primary
                      }}
                    >
                      {t.avatar_url ? (
                        <img 
                          src={t.avatar_url} 
                          alt={displayName} 
                          referrerPolicy="origin-when-cross-origin"
                          loading="lazy"
                          style={{ 
                            width: '100%', 
                            height: '100%', 
                            objectFit: 'cover',
                            transition: `opacity ${tokens.transition.base}`,
                            opacity: 0,
                          }}
                          onLoad={(e) => {
                            // 图片加载成功，平滑显示
                            e.currentTarget.style.opacity = '1'
                          }}
                          onError={(e) => {
                            // 隐藏图片，显示首字母
                            if (e.target) {
                              (e.target as HTMLImageElement).style.display = 'none'
                              // 确保容器显示渐变背景
                              const container = e.currentTarget.parentElement
                              if (container) {
                                container.style.background = getAvatarFallbackGradient(t.id)
                              }
                            }
                          }}
                        />
                      ) : null}
                      {/* 首字母 - 如果没有头像或头像加载失败时显示 */}
                      {!t.avatar_url && (
                        <Text 
                          size="xs" 
                          weight="black" 
                          style={{ 
                            color: '#ffffff',
                            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
                            fontSize: '12px',
                            lineHeight: '1',
                          }}
                        >
                          {getAvatarInitial(displayName)}
                        </Text>
                      )}
                    </Box>
                    {/* 名字 - 在头像右边 */}
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1], minWidth: 0, flex: 1 }}>
                      <Text 
                        size="sm" 
                        weight="black" 
                        style={{ 
                          color: tokens.colors.text.primary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {displayName}
                      </Text>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                        <Box
                          style={{
                            padding: `2px ${tokens.spacing[2]}`,
                            background: `${tokens.colors.accent.primary}20`,
                            borderRadius: tokens.radius.sm,
                            border: `1px solid ${tokens.colors.accent.primary}40`,
                          }}
                        >
                          <Text
                            size="xs"
                            weight="bold"
                            style={{
                              color: tokens.colors.accent.primary,
                              fontSize: '10px',
                              textTransform: 'uppercase',
                              letterSpacing: '0.5px',
                            }}
                          >
                            {sourceLabelText}
                          </Text>
                        </Box>
                        {t.followers > 0 && (
                          <Text size="xs" color="tertiary" style={{ fontSize: '10px' }}>
                            {t.followers.toLocaleString()} 粉丝
                          </Text>
                        )}
                      </Box>
                    </Box>
                  </Box>

                  {/* ROI (90D) - 上面显示百分比，下面小字显示 PnL，优化UI */}
                  <Box style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: tokens.spacing[1] }}>
                    <Text
                      size="sm"
                      weight="black"
                      style={{
                        color: t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        lineHeight: tokens.typography.lineHeight.tight,
                        fontSize: tokens.typography.fontSize.base,
                        textShadow: rank <= 3 ? `0 1px 2px ${t.roi >= 0 ? tokens.colors.accent.success + '40' : tokens.colors.accent.error + '40'}` : 'none',
                      }}
                    >
                      {t.roi >= 0 ? '+' : ''}
                      {t.roi.toFixed(2)}%
                    </Text>
                    {t.pnl !== undefined && (
                      <Text
                        size="xs"
                        weight="semibold"
                        style={{
                          color: tokens.colors.text.secondary,
                          lineHeight: tokens.typography.lineHeight.tight,
                          opacity: 0.8,
                        }}
                      >
                        {t.pnl >= 0 ? '+' : ''}
                        {formatPnL(t.pnl)}
                      </Text>
                    )}
                  </Box>

                  {/* 胜率 (90D) - 优化显示 */}
                  <Box style={{ textAlign: 'right' }}>
                    <Text 
                      size="sm" 
                      weight="bold" 
                      style={{ 
                        color: t.win_rate > 0.5 ? tokens.colors.accent.success : tokens.colors.text.secondary,
                        lineHeight: tokens.typography.lineHeight.tight,
                      }}
                    >
                      {(t.win_rate * 100).toFixed(1)}%
                    </Text>
                  </Box>

                  {/* 交易量 (90D) - 优化显示 */}
                  <Box style={{ textAlign: 'right' }}>
                    <Text 
                      size="sm" 
                      weight="semibold" 
                      style={{ 
                        color: t.volume_90d !== undefined ? tokens.colors.text.secondary : tokens.colors.text.tertiary,
                        lineHeight: tokens.typography.lineHeight.tight,
                        opacity: t.volume_90d !== undefined ? 1 : 0.5,
                      }}
                    >
                      {t.volume_90d !== undefined ? formatAmount(t.volume_90d) : '—'}
                    </Text>
                  </Box>

                  {/* 平均买入 (90D) - 优化显示 */}
                  <Box style={{ textAlign: 'right' }}>
                    <Text 
                      size="sm" 
                      weight="semibold" 
                      style={{ 
                        color: t.avg_buy_90d !== undefined ? tokens.colors.text.secondary : tokens.colors.text.tertiary,
                        lineHeight: tokens.typography.lineHeight.tight,
                        opacity: t.avg_buy_90d !== undefined ? 1 : 0.5,
                      }}
                    >
                      {t.avg_buy_90d !== undefined ? formatAmount(t.avg_buy_90d) : '—'}
                    </Text>
                  </Box>

                </Box>
              </Link>
            )
          })}
        </Box>
          
          {/* 分页控件 */}
          {totalPages > 1 && (
            <Box
              style={{
                padding: tokens.spacing[4],
                borderTop: `1px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: tokens.spacing[2],
              }}
            >
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: currentPage === 1 ? tokens.colors.bg.secondary : `${tokens.colors.accent.primary}20`,
                  border: `1px solid ${currentPage === 1 ? tokens.colors.border.primary : tokens.colors.accent.primary}40`,
                  borderRadius: tokens.radius.md,
                  color: currentPage === 1 ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                  cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  transition: `all ${tokens.transition.base}`,
                  opacity: currentPage === 1 ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (currentPage > 1) {
                    e.currentTarget.style.background = `${tokens.colors.accent.primary}30`
                    e.currentTarget.style.transform = 'translateY(-1px)'
                    e.currentTarget.style.boxShadow = tokens.shadow.sm
                  }
                }}
                onMouseLeave={(e) => {
                  if (currentPage > 1) {
                    e.currentTarget.style.background = `${tokens.colors.accent.primary}20`
                    e.currentTarget.style.transform = 'translateY(0)'
                    e.currentTarget.style.boxShadow = tokens.shadow.none
                  }
                }}
              >
                {t('prevPage')}
              </button>
              
              {/* 页码数字按钮 */}
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap', justifyContent: 'center', minWidth: 200 }}>
                {(() => {
                  // 生成页码数组
                  const pages: (number | string)[] = []
                  
                  if (totalPages <= 7) {
                    // 如果总页数 <= 7，显示所有页码
                    for (let i = 1; i <= totalPages; i++) {
                      pages.push(i)
                    }
                  } else {
                    // 如果总页数 > 7，显示部分页码
                    if (currentPage <= 3) {
                      // 当前页在前3页
                      for (let i = 1; i <= 5; i++) {
                        pages.push(i)
                      }
                      pages.push('...')
                      pages.push(totalPages)
                    } else if (currentPage >= totalPages - 2) {
                      // 当前页在后3页
                      pages.push(1)
                      pages.push('...')
                      for (let i = totalPages - 4; i <= totalPages; i++) {
                        pages.push(i)
                      }
                    } else {
                      // 当前页在中间
                      pages.push(1)
                      pages.push('...')
                      for (let i = currentPage - 1; i <= currentPage + 1; i++) {
                        pages.push(i)
                      }
                      pages.push('...')
                      pages.push(totalPages)
                    }
                  }
                  
                  return pages.map((page, idx) => {
                    if (page === '...') {
                      return (
                        <Text key={`ellipsis-${idx}`} size="sm" color="tertiary" style={{ padding: `0 ${tokens.spacing[1]}` }}>
                          ...
                        </Text>
                      )
                    }
                    
                    const pageNum = page as number
                    const isActive = pageNum === currentPage
                    
                    return (
                      <button
                        key={pageNum}
                        onClick={() => setCurrentPage(pageNum)}
                        style={{
                          minWidth: '36px',
                          height: '36px',
                          padding: `0 ${tokens.spacing[2]}`,
                          background: isActive ? `${tokens.colors.accent.primary}30` : `${tokens.colors.accent.primary}10`,
                          border: `1.5px solid ${isActive ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                          borderRadius: tokens.radius.md,
                          color: isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                          cursor: 'pointer',
                          fontSize: tokens.typography.fontSize.sm,
                          fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.semibold,
                          transition: `all ${tokens.transition.base}`,
                          boxShadow: isActive ? tokens.shadow.sm : tokens.shadow.none,
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.background = `${tokens.colors.accent.primary}20`
                            e.currentTarget.style.borderColor = tokens.colors.accent.primary
                            e.currentTarget.style.transform = 'translateY(-1px)'
                            e.currentTarget.style.boxShadow = tokens.shadow.sm
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.background = `${tokens.colors.accent.primary}10`
                            e.currentTarget.style.borderColor = tokens.colors.border.primary
                            e.currentTarget.style.transform = 'translateY(0)'
                            e.currentTarget.style.boxShadow = tokens.shadow.none
                          }
                        }}
                      >
                        {pageNum}
                      </button>
                    )
                  })
                })()}
              </Box>
              
              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: currentPage === totalPages ? tokens.colors.bg.secondary : `${tokens.colors.accent.primary}20`,
                  border: `1px solid ${currentPage === totalPages ? tokens.colors.border.primary : tokens.colors.accent.primary}40`,
                  borderRadius: tokens.radius.md,
                  color: currentPage === totalPages ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                  cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  transition: `all ${tokens.transition.base}`,
                  opacity: currentPage === totalPages ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (currentPage < totalPages) {
                    e.currentTarget.style.background = `${tokens.colors.accent.primary}30`
                    e.currentTarget.style.transform = 'translateY(-1px)'
                    e.currentTarget.style.boxShadow = tokens.shadow.sm
                  }
                }}
                onMouseLeave={(e) => {
                  if (currentPage < totalPages) {
                    e.currentTarget.style.background = `${tokens.colors.accent.primary}20`
                    e.currentTarget.style.transform = 'translateY(0)'
                    e.currentTarget.style.boxShadow = tokens.shadow.none
                  }
                }}
              >
                {t('nextPage')}
              </button>
            </Box>
          )}
        </>
      )}
    </Box>
  )
}
