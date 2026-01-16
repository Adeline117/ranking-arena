'use client'

import { useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../UI/Skeleton'
import { RankingBadge } from '../Icons'
import { Box, Text } from '../Base'
import { useLanguage } from '../Utils/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'

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
  roi: number // ROI（百分比）
  pnl?: number // 盈亏金额
  win_rate?: number // 胜率（百分比，如 85.71）- null 时显示 "—"
  max_drawdown?: number // 最大回撤（百分比）
  trades_count?: number // 交易次数
  volume_90d?: number // 交易量
  avg_buy_90d?: number // 平均买入
  followers: number // 粉丝数 - 仅来自 Arena 注册用户的关注（trader_follows 表统计）
  source?: string // 数据来源：binance, bybit, okx等
  avatar_url?: string // 头像URL
  arena_score?: number // Arena Score (0-100)
  return_score?: number // 收益分
  drawdown_score?: number // 回撤分
  stability_score?: number // 稳定分
}

/**
 * 排行榜页面 - 极度克制，只解决"谁最强"的问题
 * 只保留：排名、交易员ID、ROI、PnL、胜率、最大回撤
 */
export default function RankingTable(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
  source?: string // 数据来源
  timeRange?: '7D' | '30D' | '90D' // 时间段
}) {
  const { traders, loading, source, timeRange = '90D' } = props
  const { t } = useLanguage()
  
  // 分页状态
  const [currentPage, setCurrentPage] = useState(1)
  const [showRules, setShowRules] = useState(false)
  const itemsPerPage = 20 // 每页显示 20 条

  // API 已经完成了过滤（PNL >= $1000）和排序（ROI 降序 → 回撤小 → 交易次数多）
  // 前端直接使用 API 返回的数据，不再重复过滤和排序
  const sortedTraders = traders.slice(0, 100) // 确保最多显示100人
  
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
          gridTemplateColumns: '36px minmax(90px, 1fr) 52px 80px 50px 50px', // Rank | Trader | Score | ROI+PnL | Win Rate | MDD
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
          borderBottom: `2px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.secondary,
          borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
          boxShadow: tokens.shadow.xs,
        }}
      >
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('rank')}
        </Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {t('trader')}
          </Text>
          <button
            onClick={() => setShowRules(!showRules)}
            style={{
              background: 'transparent',
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.full,
              width: 16,
              height: 16,
              fontSize: 10,
              color: tokens.colors.text.tertiary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              transition: `all ${tokens.transition.fast}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.accent.primary
              e.currentTarget.style.color = tokens.colors.accent.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.border.primary
              e.currentTarget.style.color = tokens.colors.text.tertiary
            }}
            title="排名规则"
          >
            ?
          </button>
        </Box>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Score
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          ROI ({timeRange})
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('winRate')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t('drawdown')}
        </Text>
      </Box>

      {/* 排名规则说明 */}
      {showRules && (
        <Box
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            background: `${tokens.colors.accent.primary}10`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.secondary,
            lineHeight: 1.6,
          }}
        >
          <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, marginBottom: 6, display: 'block' }}>
            Arena Score 排名规则
          </Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>① 按 Arena Score 从高到低排序（0-100 分）</span>
            <span>② 分数构成：收益分（85%）+ 稳定/风险分（15%）</span>
            <span>③ Score 相同时，回撤更小的靠前</span>
            <span style={{ color: tokens.colors.text.tertiary, marginTop: 4 }}>
              * 入榜门槛：7D &gt; $300 | 30D &gt; $1,000 | 90D &gt; $3,000
            </span>
          </div>
        </Box>
      )}

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
            {paginatedTraders.map((trader, idx) => {
              const rank = startIndex + idx + 1 // 全局排名
              const traderHandle = trader.handle || trader.id
              const href = `/trader/${encodeURIComponent(traderHandle)}`
              // 使用组合 key 确保唯一性：id + source + index
              const uniqueKey = `${trader.id}-${trader.source || 'unknown'}-${startIndex + idx}`
              
              // 格式化显示名称：如果是钱包地址（以0x开头且长度>20），则截断
              const formatDisplayName = (name: string) => {
                // 判断是否是钱包地址（0x开头，长度>20）
                if (name.startsWith('0x') && name.length > 20) {
                  return `${name.substring(0, 6)}...${name.substring(name.length - 4)}`
                }
                return name
              }
              
              const displayName = formatDisplayName(traderHandle)
              const sourceLabelText = trader.source ? (sourceLabels[trader.source] || trader.source) : sourceLabel

              const ariaLabel = `${t('rank')} ${rank}, ${t('trader')} ${displayName}, ROI ${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%, ${t('winRate')} ${trader.win_rate != null ? trader.win_rate.toFixed(1) + '%' : '—'}`
              
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
                      gridTemplateColumns: '36px minmax(90px, 1fr) 52px 80px 50px 50px', // Rank | Trader | Score | ROI+PnL | Win Rate | MDD
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
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
                  <Box style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
                    {/* 头像 - 放在名字左边，优化UI */}
                    <Box
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: tokens.radius.full,
                        background: getAvatarGradient(trader.id),
                        border: `1.5px solid ${tokens.colors.border.primary}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: tokens.typography.fontWeight.black,
                        fontSize: '10px',
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
                      {/* 首字母 - 始终存在作为底层 */}
                      <Text 
                        size="xs" 
                        weight="black" 
                        style={{ 
                          color: '#ffffff',
                          textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
                          fontSize: '10px',
                          lineHeight: '1',
                        }}
                      >
                        {getAvatarInitial(displayName)}
                      </Text>
                      {/* 头像图片 - 如果有且加载成功则覆盖首字母 */}
                      {trader.avatar_url && (
                        <img 
                          src={trader.avatar_url} 
                          alt={displayName} 
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          style={{ 
                            width: '100%', 
                            height: '100%', 
                            objectFit: 'cover',
                            position: 'absolute',
                            inset: 0,
                          }}
                          onError={(e) => {
                            // 隐藏图片，首字母会自动显示
                            if (e.target) {
                              (e.target as HTMLImageElement).style.display = 'none'
                            }
                          }}
                        />
                      )}
                    </Box>
                    {/* 名字 - 在头像右边 */}
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                      <Text 
                        size="xs" 
                        weight="black" 
                        style={{ 
                          color: tokens.colors.text.primary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: '13px',
                        }}
                      >
                        {displayName}
                      </Text>
                      <Box
                        style={{
                          padding: '1px 4px',
                          background: `${tokens.colors.accent.primary}20`,
                          borderRadius: tokens.radius.sm,
                          display: 'inline-flex',
                          width: 'fit-content',
                        }}
                      >
                        <Text
                          size="xs"
                          weight="bold"
                          style={{
                            color: tokens.colors.accent.primary,
                            fontSize: '9px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.3px',
                          }}
                        >
                          {sourceLabelText}
                        </Text>
                      </Box>
                    </Box>
                  </Box>

                  {/* Arena Score - 核心排名指标 */}
                  <Box style={{ textAlign: 'center' }}>
                    <Box
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minWidth: 40,
                        padding: '4px 8px',
                        background: trader.arena_score != null && trader.arena_score >= 60 
                          ? `${tokens.colors.accent.success}20`
                          : trader.arena_score != null && trader.arena_score >= 40
                            ? `${tokens.colors.accent.warning}15`
                            : `${tokens.colors.bg.tertiary}`,
                        borderRadius: tokens.radius.md,
                        border: `1px solid ${
                          trader.arena_score != null && trader.arena_score >= 60 
                            ? tokens.colors.accent.success + '40'
                            : trader.arena_score != null && trader.arena_score >= 40
                              ? tokens.colors.accent.warning + '30'
                              : tokens.colors.border.primary
                        }`,
                      }}
                    >
                      <Text
                        size="sm"
                        weight="black"
                        style={{
                          color: trader.arena_score != null && trader.arena_score >= 60 
                            ? tokens.colors.accent.success
                            : trader.arena_score != null && trader.arena_score >= 40
                              ? tokens.colors.accent.warning
                              : tokens.colors.text.secondary,
                          fontSize: '13px',
                          lineHeight: 1,
                        }}
                      >
                        {trader.arena_score != null ? trader.arena_score.toFixed(1) : '—'}
                      </Text>
                    </Box>
                  </Box>

                  {/* ROI (90D) - 上面显示百分比，下面小字显示 PnL，优化UI */}
                  <Box style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                    <Text
                      size="sm"
                      weight="black"
                      style={{
                        color: (trader.roi || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        lineHeight: 1.2,
                        fontSize: '13px',
                        textShadow: rank <= 3 ? `0 1px 2px ${(trader.roi || 0) >= 0 ? tokens.colors.accent.success + '40' : tokens.colors.accent.error + '40'}` : 'none',
                      }}
                    >
                      {(trader.roi || 0) >= 0 ? '+' : ''}
                      {(trader.roi || 0).toFixed(2)}%
                    </Text>
                    <Text
                      size="xs"
                      weight="semibold"
                      style={{
                        color: trader.pnl != null 
                          ? (trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
                          : tokens.colors.text.tertiary,
                        lineHeight: 1.2,
                        fontSize: '10px',
                        opacity: trader.pnl != null ? 0.9 : 0.5,
                      }}
                    >
                      {trader.pnl != null 
                        ? `${trader.pnl >= 0 ? '+' : ''}${formatPnL(trader.pnl)}`
                        : '—'
                      }
                    </Text>
                  </Box>

                  {/* 胜率 - 已经是百分比，不需要乘100 */}
                  <Box style={{ textAlign: 'right' }}>
                    <Text 
                      size="xs" 
                      weight="bold" 
                      style={{ 
                        color: trader.win_rate != null && trader.win_rate > 50 ? tokens.colors.accent.success : tokens.colors.text.secondary,
                        lineHeight: 1.2,
                        fontSize: '12px',
                      }}
                    >
                      {trader.win_rate != null ? `${trader.win_rate.toFixed(1)}%` : '—'}
                    </Text>
                  </Box>

                  {/* 最大回撤 */}
                  <Box style={{ textAlign: 'right' }}>
                    <Text 
                      size="xs" 
                      weight="semibold" 
                      style={{ 
                        color: trader.max_drawdown != null ? tokens.colors.accent.error : tokens.colors.text.tertiary,
                        lineHeight: 1.2,
                        fontSize: '12px',
                        opacity: trader.max_drawdown != null ? 1 : 0.5,
                      }}
                    >
                      {trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(1)}%` : '—'}
                    </Text>
                  </Box>

                </Box>
              </Link>
            )
          })}
        </Box>
          
          {/* 分页控件 - 优化UI */}
          {totalPages > 1 && (
            <Box
              style={{
                padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
                borderTop: `2px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: tokens.spacing[2],
                background: tokens.colors.bg.primary,
                borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`,
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
