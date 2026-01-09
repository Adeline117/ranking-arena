'use client'

import { useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../UI/Skeleton'
import { RankingBadge } from '../Icons'
import { Box, Text } from '../Base'
import { useLanguage } from '../Utils/LanguageProvider'
import Avatar from '../UI/Avatar'

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
      radius="none"
      border="none"
    >
      {/* Header - 最小化 */}
      <Box
        className="ranking-table-header ranking-table-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '60px 1fr 120px 80px 100px 100px', // Rank | ID | ROI (90D) | Win Rate (90D) | Volume (90D) | Avg Buy (90D)
          gap: tokens.spacing[4],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center' }}>
          {t('rank')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary">
          {t('trader')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
          {t('roi90d')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
          {t('winRate90d')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
          {t('volume90d')}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
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

              return (
                <Link
                  key={uniqueKey}
                  href={href}
                  style={{ textDecoration: 'none' }}
                >
                  <Box
                    className="ranking-table-grid"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '60px 1fr 120px 80px 100px 100px',
                      alignItems: 'center',
                      gap: tokens.spacing[4],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                      cursor: 'pointer',
                      background: tokens.colors.bg.primary,
                      transition: `all ${tokens.transition.base}`,
                      borderRadius: tokens.radius.none,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.tertiary || tokens.colors.bg.hover
                      e.currentTarget.style.transform = 'translateX(4px)'
                      e.currentTarget.style.boxShadow = tokens.shadow.xs
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.primary
                      e.currentTarget.style.transform = 'translateX(0)'
                      e.currentTarget.style.boxShadow = tokens.shadow.none
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
                    {/* 头像 - 放在名字左边 */}
                    <Avatar
                      userId={t.id}
                      name={displayName}
                      avatarUrl={t.avatar_url}
                      size={32}
                      isTrader={true}
                    />
                    {/* 名字 - 在头像右边 */}
                    <Text size="sm" weight="black" style={{ color: tokens.colors.text.primary }}>
                      {displayName}
                    </Text>
                    <Text
                      size="xs"
                      weight="medium"
                      style={{
                        color: tokens.colors.text.tertiary,
                        padding: '2px 6px',
                        background: 'rgba(139, 111, 168, 0.1)',
                        borderRadius: 4,
                        border: '1px solid rgba(139, 111, 168, 0.2)',
                        fontSize: '10px',
                      }}
                    >
                      {sourceLabelText}
                    </Text>
                  </Box>

                  {/* ROI (90D) - 上面显示百分比，下面小字显示 PnL */}
                  <Box style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <Text
                      size="sm"
                      weight="black"
                      style={{
                        color: t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        lineHeight: 1.2,
                      }}
                    >
                      {t.roi >= 0 ? '+' : ''}
                      {t.roi.toFixed(2)}%
                    </Text>
                    {t.pnl !== undefined && (
                      <Text
                        size="xs"
                        weight="normal"
                        style={{
                          color: tokens.colors.text.tertiary,
                          marginTop: '2px',
                          lineHeight: 1.2,
                        }}
                      >
                        {t.pnl >= 0 ? '+' : ''}
                        {formatPnL(t.pnl)}
                      </Text>
                    )}
                  </Box>

                  {/* 胜率 (90D) - 中性色 */}
                  <Text size="sm" weight="bold" style={{ textAlign: 'right', color: tokens.colors.text.secondary }}>
                    {(t.win_rate * 100).toFixed(1)}%
                  </Text>

                  {/* 交易量 (90D) - 中性色 */}
                  <Text size="sm" weight="bold" style={{ textAlign: 'right', color: tokens.colors.text.secondary }}>
                    {t.volume_90d !== undefined ? formatAmount(t.volume_90d) : '—'}
                  </Text>

                  {/* 平均买入 (90D) - 中性色 */}
                  <Text size="sm" weight="bold" style={{ textAlign: 'right', color: tokens.colors.text.secondary }}>
                    {t.avg_buy_90d !== undefined ? formatAmount(t.avg_buy_90d) : '—'}
                  </Text>

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
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  background: currentPage === 1 ? 'transparent' : 'rgba(139, 111, 168, 0.1)',
                  border: `1px solid ${currentPage === 1 ? 'rgba(139, 111, 168, 0.2)' : 'rgba(139, 111, 168, 0.3)'}`,
                  borderRadius: tokens.radius.md,
                  color: currentPage === 1 ? tokens.colors.text.tertiary : tokens.colors.text.secondary,
                  cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  if (currentPage > 1) {
                    e.currentTarget.style.background = 'rgba(139, 111, 168, 0.2)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (currentPage > 1) {
                    e.currentTarget.style.background = 'rgba(139, 111, 168, 0.1)'
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
                          minWidth: '32px',
                          height: '32px',
                          padding: `0 ${tokens.spacing[2]}`,
                          background: isActive ? 'rgba(139, 111, 168, 0.3)' : 'rgba(139, 111, 168, 0.1)',
                          border: `1px solid ${isActive ? 'rgba(139, 111, 168, 0.5)' : 'rgba(139, 111, 168, 0.3)'}`,
                          borderRadius: tokens.radius.md,
                          color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                          cursor: 'pointer',
                          fontSize: tokens.typography.fontSize.sm,
                          fontWeight: isActive ? 700 : 600,
                          transition: 'all 0.2s ease',
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.background = 'rgba(139, 111, 168, 0.2)'
                            e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.4)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.background = 'rgba(139, 111, 168, 0.1)'
                            e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.3)'
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
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  background: currentPage === totalPages ? 'transparent' : 'rgba(139, 111, 168, 0.1)',
                  border: `1px solid ${currentPage === totalPages ? 'rgba(139, 111, 168, 0.2)' : 'rgba(139, 111, 168, 0.3)'}`,
                  borderRadius: tokens.radius.md,
                  color: currentPage === totalPages ? tokens.colors.text.tertiary : tokens.colors.text.secondary,
                  cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  if (currentPage < totalPages) {
                    e.currentTarget.style.background = 'rgba(139, 111, 168, 0.2)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (currentPage < totalPages) {
                    e.currentTarget.style.background = 'rgba(139, 111, 168, 0.1)'
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
