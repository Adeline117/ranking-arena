'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../UI/Skeleton'
import { RankingBadge } from '../Icons'
import { Box, Text } from '../Base'
import { useLanguage } from '../Providers/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { ScoreRulesModal } from '../UI/ScoreRulesModal'
import CategoryRankingTabs, { CategoryType, filterByCategory } from './CategoryRankingTabs'
import { ProLabel } from '../Pro/PremiumGate'

// 图标组件
const FilterIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CompareIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="18" rx="1" />
    <rect x="14" y="3" width="7" height="18" rx="1" />
  </svg>
)

const LockIconSmall = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z" />
    <path d="M7 11V7C7 4.2 9.2 2 12 2C14.8 2 17 4.2 17 7V11" stroke="currentColor" strokeWidth="2" fill="none" />
  </svg>
)

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


// 格式化 ROI 显示（处理极端值）
function formatROI(roi: number): string {
  const absRoi = Math.abs(roi)
  if (absRoi >= 10000) {
    return `${roi >= 0 ? '+' : ''}${(roi / 1000).toFixed(0)}K%`
  } else if (absRoi >= 1000) {
    return `${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%`
  } else {
    return `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`
  }
}

export interface Trader {
  id: string
  handle: string | null
  roi: number // ROI（百分比）
  pnl?: number | null // 盈亏金额 - 某些交易所不返回
  win_rate?: number | null // 胜率（百分比，如 85.71）- null 时显示 "—"
  max_drawdown?: number | null // 最大回撤（百分比）
  trades_count?: number | null // 交易次数
  followers: number // 粉丝数 - 仅来自 Arena 注册用户的关注（trader_follows 表统计）
  source?: string // 数据来源：binance, bybit, okx等
  avatar_url?: string | null // 头像URL
  arena_score?: number // Arena Score (0-100)
  return_score?: number // 收益分
  drawdown_score?: number // 回撤分
  stability_score?: number // 稳定分
}

// CSS animations for top 3
const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('ranking-table-styles')) return
  
  const style = document.createElement('style')
  style.id = 'ranking-table-styles'
  style.textContent = `
    /* 奖牌发光效果 */
    @keyframes medalGlowGold {
      0%, 100% { 
        filter: drop-shadow(0 0 4px rgba(255, 215, 0, 0.6)) drop-shadow(0 0 8px rgba(255, 215, 0, 0.4));
      }
      50% { 
        filter: drop-shadow(0 0 8px rgba(255, 215, 0, 0.8)) drop-shadow(0 0 16px rgba(255, 215, 0, 0.5));
      }
    }
    
    @keyframes medalGlowSilver {
      0%, 100% { 
        filter: drop-shadow(0 0 3px rgba(192, 192, 192, 0.6)) drop-shadow(0 0 6px rgba(192, 192, 192, 0.4));
      }
      50% { 
        filter: drop-shadow(0 0 6px rgba(192, 192, 192, 0.8)) drop-shadow(0 0 12px rgba(192, 192, 192, 0.5));
      }
    }
    
    @keyframes medalGlowBronze {
      0%, 100% { 
        filter: drop-shadow(0 0 3px rgba(205, 127, 50, 0.6)) drop-shadow(0 0 6px rgba(205, 127, 50, 0.4));
      }
      50% { 
        filter: drop-shadow(0 0 6px rgba(205, 127, 50, 0.8)) drop-shadow(0 0 12px rgba(205, 127, 50, 0.5));
      }
    }
    
    /* 奖牌发光类 */
    .medal-glow-gold {
      animation: medalGlowGold 2s ease-in-out infinite;
    }
    
    .medal-glow-silver {
      animation: medalGlowSilver 2s ease-in-out infinite;
    }
    
    .medal-glow-bronze {
      animation: medalGlowBronze 2s ease-in-out infinite;
    }
    
    /* 普通行样式 */
    .ranking-row {
      transition: all 0.2s ease;
    }
    
    .ranking-row:hover {
      background: var(--glass-bg-light) !important;
    }
    
    @media (prefers-reduced-motion: reduce) {
      .medal-glow-gold, .medal-glow-silver, .medal-glow-bronze {
        animation: none;
      }
    }
  `
  document.head.appendChild(style)
}

/**
 * 排行榜页面 - 核心功能，突出前三名
 * 只保留：排名、交易员ID、ROI、PnL、胜率、最大回撤
 */
export default function RankingTable(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
  source?: string // 数据来源
  timeRange?: '7D' | '30D' | '90D' // 时间段
  isPro?: boolean // 是否为 Pro 会员
  category?: CategoryType // 当前分类
  onCategoryChange?: (category: CategoryType) => void // 分类切换回调
  onProRequired?: () => void // 需要升级 Pro 时的回调
}) {
  const { traders, loading, source, timeRange = '90D', isPro = false, category = 'all', onCategoryChange, onProRequired } = props
  const { t, language } = useLanguage()
  const router = useRouter()
  
  // 分页状态
  const [currentPage, setCurrentPage] = useState(1)
  const [showRules, setShowRules] = useState(false)
  const [showScoreRulesModal, setShowScoreRulesModal] = useState(false)
  const itemsPerPage = 20 // 每页显示 20 条

  // Inject styles on mount
  useEffect(() => {
    injectStyles()
  }, [])

  // API 已经完成了过滤（PNL >= $1000）和排序（ROI 降序 → 回撤小 → 交易次数多）
  // 前端直接使用 API 返回的数据，不再重复过滤和排序
  const sortedTraders = traders.slice(0, 100) // 确保最多显示100人
  
  // 计算分页
  const totalPages = Math.ceil(sortedTraders.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const paginatedTraders = sortedTraders.slice(startIndex, endIndex)
  
  // 解析 source 为交易所名称和类型
  type SourceInfo = { exchange: string; type: string; typeColor: string }
  
  const parseSourceInfo = (src: string): SourceInfo => {
    // 交易所名称映射
    const exchangeMap: Record<string, string> = {
      'binance': 'Binance',
      'bybit': 'Bybit',
      'bitget': 'Bitget',
      'mexc': 'MEXC',
      'coinex': 'CoinEx',
      'okx': 'OKX',
      'kucoin': 'KuCoin',
      'gmx': 'GMX',
    }
    
    // 类型映射（中英文）- 统一颜色，不做颜色区分
    const typeMap: Record<string, { label: string; color: string }> = {
      'futures': { label: '合约', color: tokens.colors.text.secondary },
      'spot': { label: '现货', color: tokens.colors.text.secondary },
      'web3': { label: '链上', color: tokens.colors.text.secondary },
    }
    
    // 解析 source 字符串
    const parts = src.toLowerCase().split('_')
    let exchange = parts[0]
    let type = parts[1] || 'futures' // 默认合约
    
    // 特殊处理 bybit（默认合约）、gmx（链上）
    if (src === 'bybit') type = 'futures'
    if (src === 'gmx') type = 'web3'
    if (src === 'mexc' || src === 'coinex' || src === 'kucoin') type = 'futures'
    
    const exchangeName = exchangeMap[exchange] || exchange.charAt(0).toUpperCase() + exchange.slice(1)
    const typeInfo = typeMap[type] || { label: type, color: tokens.colors.text.tertiary }
    
    return {
      exchange: exchangeName,
      type: typeInfo.label,
      typeColor: typeInfo.color,
    }
  }
  
  // 保留原有的完整标签映射（用于可访问性）
  const sourceLabels: Record<string, string> = {
    'binance_futures': 'Binance 合约',
    'binance_spot': 'Binance 现货',
    'binance_web3': 'Binance 链上',
    'bybit': 'Bybit 合约',
    'bitget_futures': 'Bitget 合约',
    'bitget_spot': 'Bitget 现货',
    'mexc': 'MEXC 合约',
    'coinex': 'CoinEx 合约',
    'okx_web3': 'OKX 链上',
    'kucoin': 'KuCoin 合约',
    'gmx': 'GMX 链上',
  }
  
  const sourceLabel = source ? sourceLabels[source] || source : t('unknownSource')

  // Get medal glow class based on rank
  const getMedalGlowClass = (rank: number) => {
    if (rank === 1) return 'medal-glow-gold'
    if (rank === 2) return 'medal-glow-silver'
    if (rank === 3) return 'medal-glow-bronze'
    return ''
  }

  return (
    <Box
      className="glass-card"
      p={0}
      radius="xl"
      style={{
        boxShadow: `${tokens.shadow.lg}, 0 0 0 1px var(--glass-border-light)`,
        overflow: 'hidden',
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        border: tokens.glass.border.light,
      }}
    >
      {/* Category Tabs - Pro 功能 + 工具按钮 */}
      {onCategoryChange && (
        <Box
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacing[3],
            borderBottom: `1px solid var(--glass-border-light)`,
            background: tokens.glass.bg.light,
            borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
            flexWrap: 'wrap',
          }}
        >
          {/* 左侧：分类标签 */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flex: '1 1 auto', minWidth: 0 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
              <Text size="sm" weight="bold" color="secondary">
                {language === 'en' ? 'Category' : '分类'}
              </Text>
              <ProLabel size="xs" />
            </Box>
            <CategoryRankingTabs
              currentCategory={category}
              onCategoryChange={onCategoryChange}
              isPro={isPro}
              onProRequired={onProRequired}
            />
          </Box>
          
          {/* 右侧：工具按钮 */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
            {/* 高级筛选按钮 */}
            <Box
              onClick={isPro ? () => {} : onProRequired}
              title={language === 'en' ? 'Advanced Filter' : '高级筛选'}
              className="touch-target-sm"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                width: 32,
                height: 32,
                borderRadius: tokens.radius.md,
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--color-border-secondary)',
                color: isPro ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
                cursor: isPro ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s',
                opacity: isPro ? 1 : 0.5,
              }}
              onMouseEnter={(e) => {
                if (isPro) {
                  e.currentTarget.style.borderColor = 'var(--color-pro-gradient-start)'
                  e.currentTarget.style.color = 'var(--color-pro-gradient-start)'
                  e.currentTarget.style.background = 'var(--color-pro-glow)'
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border-secondary)'
                e.currentTarget.style.color = isPro ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)'
                e.currentTarget.style.background = 'var(--color-bg-tertiary)'
              }}
            >
              <FilterIcon size={14} />
              {!isPro && <LockIconSmall size={8} />}
            </Box>

            {/* 对比按钮 */}
            <Link
              href={isPro ? '/compare' : '/pricing'}
              title={language === 'en' ? 'Compare Traders' : '交易员对比'}
              className="touch-target-sm"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                width: 32,
                height: 32,
                borderRadius: tokens.radius.md,
                background: isPro ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)',
                border: isPro ? '1px solid var(--color-pro-gradient-start)' : '1px solid var(--color-border-secondary)',
                color: isPro ? 'var(--color-pro-gradient-start)' : 'var(--color-text-tertiary)',
                textDecoration: 'none',
                cursor: isPro ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s',
                opacity: isPro ? 1 : 0.5,
              }}
              onMouseEnter={(e) => {
                if (isPro) {
                  e.currentTarget.style.background = 'var(--color-pro-badge-bg)'
                  e.currentTarget.style.color = '#fff'
                }
              }}
              onMouseLeave={(e) => {
                if (isPro) {
                  e.currentTarget.style.background = 'var(--color-pro-glow)'
                  e.currentTarget.style.color = 'var(--color-pro-gradient-start)'
                }
              }}
            >
              <CompareIcon size={14} />
              {!isPro && <LockIconSmall size={8} />}
            </Link>
          </Box>
        </Box>
      )}

      {/* Header - 增大字体和间距 */}
      <Box
        className="ranking-table-header ranking-table-grid"
        style={{
          display: 'grid',
          // 增大列宽：Rank | Trader | Score | ROI+PnL | Win Rate | MDD
          gridTemplateColumns: '44px minmax(140px, 1.5fr) 64px 90px 70px 70px',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid var(--glass-border-light)`,
          background: onCategoryChange ? 'transparent' : tokens.glass.bg.light,
          borderRadius: onCategoryChange ? '0' : `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
        }}
      >
        <Text size="sm" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px' }}>
          {t('rank')}
        </Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px' }}>
            {t('trader')}
          </Text>
          <button
            onClick={() => setShowRules(!showRules)}
            style={{
              background: 'transparent',
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.full,
              width: 18,
              height: 18,
              fontSize: 11,
              color: tokens.colors.text.tertiary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              transition: `all ${tokens.transition.fast}`,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.accent.primary
              e.currentTarget.style.color = tokens.colors.accent.primary
              e.currentTarget.style.transform = 'scale(1.1)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.border.primary
              e.currentTarget.style.color = tokens.colors.text.tertiary
              e.currentTarget.style.transform = 'scale(1)'
            }}
            title="排名规则"
          >
            ?
          </button>
        </Box>
        <Text className="col-score" size="sm" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', alignItems: 'center', justifyContent: 'center' }}>
          Score
        </Text>
        <Text size="sm" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px' }}>
          ROI
        </Text>
        <Text className="col-winrate" size="sm" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', alignItems: 'center', justifyContent: 'flex-end' }}>
          Win%
        </Text>
        <Text className="col-mdd" size="sm" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', alignItems: 'center', justifyContent: 'flex-end' }}>
          MDD
        </Text>
      </Box>

      {/* 排名规则说明 */}
      {showRules && (
        <Box
          style={{
            padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
            background: `${tokens.colors.accent.primary}10`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.secondary,
            lineHeight: 1.7,
          }}
        >
          <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary, marginBottom: 8, display: 'block' }}>
            Arena Score 排名规则
          </Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>① 按 Arena Score 从高到低排序（0-100 分）</span>
            <span>② 分数构成：收益分（85%）+ 稳定/风险分（15%）</span>
            <span>③ Score 相同时，回撤更小的靠前</span>
            <span style={{ color: tokens.colors.text.tertiary, marginTop: 6 }}>
              * 入榜门槛（PNL 收益）：7D &gt; $300 | 30D &gt; $1,000 | 90D &gt; $3,000
            </span>
          </div>
          <button
            onClick={() => setShowScoreRulesModal(true)}
            style={{
              marginTop: 12,
              padding: '6px 14px',
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              color: tokens.colors.accent.primary,
              background: `${tokens.colors.accent.primary}15`,
              border: `1px solid ${tokens.colors.accent.primary}30`,
              borderRadius: tokens.radius.md,
              cursor: 'pointer',
              transition: tokens.transition.base,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `${tokens.colors.accent.primary}25`
              e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}50`
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = `${tokens.colors.accent.primary}15`
              e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}30`
            }}
          >
            详细
          </button>
        </Box>
      )}

      {/* Arena Score 详细规则弹窗 */}
      <ScoreRulesModal 
        isOpen={showScoreRulesModal} 
        onClose={() => setShowScoreRulesModal(false)} 
      />

      {loading ? (
        <RankingSkeleton />
      ) : sortedTraders.length === 0 ? (
        <Box
          style={{
            color: tokens.colors.text.tertiary,
            padding: `${tokens.spacing[10]} ${tokens.spacing[4]}`,
            textAlign: 'center',
            fontSize: tokens.typography.fontSize.md,
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
              const uniqueKey = `${trader.id}-${trader.source || 'unknown'}-${startIndex + idx}`
              
              // 格式化显示名称
              const formatDisplayName = (name: string) => {
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
                  className="ranking-row-link"
                  style={{ textDecoration: 'none', display: 'block' }}
                  aria-label={ariaLabel}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      router.push(href)
                    }
                  }}
                >
                  <Box
                    className="ranking-row ranking-table-grid touch-target"
                    role="row"
                    style={{
                      display: 'grid',
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`,
                      borderBottom: `1px solid var(--glass-border-light)`,
                      cursor: 'pointer',
                      position: 'relative',
                      minHeight: 72,
                    }}
                  >
                    {/* 排名 - 前三名发光特效 */}
                    <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {rank <= 3 ? (
                        <Box className={getMedalGlowClass(rank)} style={{ transform: 'scale(1.1)' }}>
                          <RankingBadge rank={rank as 1 | 2 | 3} size={28} />
                        </Box>
                      ) : (
                        <Text size="sm" weight="bold" color="tertiary" style={{ fontSize: '14px' }}>
                          #{rank}
                        </Text>
                      )}
                    </Box>

                    {/* 交易员ID */}
                    <Box style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
                      {/* 头像 */}
                      <div
                        className="trader-avatar"
                        style={{
                          width: '36px',
                          height: '36px',
                          minWidth: '36px',
                          minHeight: '36px',
                          borderRadius: '50%',
                          background: getAvatarGradient(trader.id),
                          border: '2px solid var(--color-border-primary)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          flexShrink: 0,
                          position: 'relative',
                          boxShadow: rank <= 3 ? `0 0 12px ${rank === 1 ? 'rgba(255, 215, 0, 0.4)' : rank === 2 ? 'rgba(192, 192, 192, 0.4)' : 'rgba(205, 127, 50, 0.4)'}` : 'none',
                        }}
                      >
                        {/* 首字母 */}
                        <span style={{ 
                          color: '#ffffff',
                          fontSize: '14px',
                          fontWeight: 900,
                          lineHeight: 1,
                          textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                          letterSpacing: '0',
                        }}>
                          {getAvatarInitial(displayName)}
                        </span>
                        {/* 头像图片 */}
                        {trader.avatar_url && !trader.avatar_url.includes('t.co') && !trader.avatar_url.includes('/banner/') && (
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
                              zIndex: 1,
                            }}
                            onError={(e) => {
                              const img = e.target as HTMLImageElement
                              img.style.display = 'none'
                            }}
                          />
                        )}
                      </div>
                      {/* 名字 + 交易所标签（拆分为交易所名 + 类型） */}
                      <Box style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                        <Text 
                          size="sm"
                          weight="bold" 
                          style={{ 
                            color: tokens.colors.text.primary,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: '14px',
                          }}
                        >
                          {displayName}
                        </Text>
                        {/* 拆分的交易所标签：交易所名 + 类型 */}
                        <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {(() => {
                            const info = parseSourceInfo(trader.source || source || '')
                            return (
                              <>
                                {/* 交易所名称标签 */}
                                <Text
                                  size="xs"
                                  weight="bold"
                                  style={{
                                    color: tokens.colors.text.secondary,
                                    fontSize: '10px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.3px',
                                  }}
                                >
                                  {info.exchange}
                                </Text>
                                {/* 类型标签（合约/现货/链上） */}
                                <Box
                                  style={{
                                    padding: '2px 6px',
                                    borderRadius: tokens.radius.sm,
                                    background: `${info.typeColor}15`,
                                    border: `1px solid ${info.typeColor}30`,
                                  }}
                                >
                                  <Text
                                    size="xs"
                                    weight="bold"
                                    style={{
                                      color: info.typeColor,
                                      fontSize: '9px',
                                      lineHeight: 1.2,
                                    }}
                                  >
                                    {info.type}
                                  </Text>
                                </Box>
                              </>
                            )
                          })()}
                        </Box>
                      </Box>
                    </Box>

                    {/* Arena Score - 前三名带光效 */}
                    <Box className="col-score" style={{ textAlign: 'center', display: 'flex', justifyContent: 'center' }}>
                      <Box
                        style={{
                          position: 'relative',
                          minWidth: 46,
                          height: 24,
                          borderRadius: tokens.radius.md,
                          background: trader.arena_score != null && trader.arena_score >= 60 
                            ? tokens.gradient.successSubtle
                            : trader.arena_score != null && trader.arena_score >= 40
                              ? tokens.gradient.warningSubtle
                              : tokens.glass.bg.light,
                          border: `1px solid ${
                            trader.arena_score != null && trader.arena_score >= 60 
                              ? `${tokens.colors.accent.success}50`
                              : trader.arena_score != null && trader.arena_score >= 40
                                ? `${tokens.colors.accent.warning}40`
                                : 'rgba(255, 255, 255, 0.15)'
                          }`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                        }}
                      >
                        {/* Progress background */}
                        {trader.arena_score != null && (
                          <Box
                            style={{
                              position: 'absolute',
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: `${trader.arena_score}%`,
                              background: trader.arena_score >= 60 
                                ? `${tokens.colors.accent.success}20`
                                : trader.arena_score >= 40
                                  ? `${tokens.colors.accent.warning}20`
                                  : `${tokens.colors.accent.primary}15`,
                              transition: 'width 0.3s ease',
                            }}
                          />
                        )}
                        <Text
                          size="sm"
                          weight="black"
                          style={{
                            position: 'relative',
                            color: trader.arena_score != null && trader.arena_score >= 60 
                              ? tokens.colors.accent.success
                              : trader.arena_score != null && trader.arena_score >= 40
                                ? tokens.colors.accent.warning
                                : tokens.colors.text.secondary,
                            fontSize: '12px',
                            lineHeight: 1,
                          }}
                        >
                          {trader.arena_score != null ? trader.arena_score.toFixed(1) : '—'}
                        </Text>
                      </Box>
                    </Box>

                    {/* ROI - 移动端增大字体 */}
                    <Box className="roi-cell" style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <Text
                        size="md"
                        weight="black"
                        className="roi-value"
                        style={{
                          color: (trader.roi || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                          lineHeight: 1.2,
                          fontSize: '16px',
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        title={`${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}
                      >
                        {formatROI(trader.roi || 0)}
                      </Text>
                      <Text
                        size="xs"
                        weight="semibold"
                        className="pnl-value"
                        style={{
                          color: trader.pnl != null 
                            ? (trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
                            : tokens.colors.text.tertiary,
                          lineHeight: 1.2,
                          fontSize: '11px',
                          opacity: trader.pnl != null ? 0.85 : 0.5,
                        }}
                      >
                        {trader.pnl != null 
                          ? `${trader.pnl >= 0 ? '+' : ''}${formatPnL(trader.pnl)}`
                          : '—'
                        }
                      </Text>
                    </Box>

                    {/* 胜率 - 增大字体 */}
                    <Box className="col-winrate" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
                      <Text 
                        size="sm"
                        weight="semibold" 
                        style={{ 
                          color: trader.win_rate != null && trader.win_rate > 0.5 ? tokens.colors.accent.success : tokens.colors.text.secondary,
                          lineHeight: 1,
                          fontSize: '13px',
                        }}
                      >
                        {trader.win_rate != null ? `${trader.win_rate.toFixed(0)}%` : '—'}
                      </Text>
                    </Box>

                    {/* 最大回撤 - 增大字体 */}
                    <Box className="col-mdd" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
                      <Text 
                        size="sm"
                        weight="semibold" 
                        style={{ 
                          color: trader.max_drawdown != null ? tokens.colors.accent.error : tokens.colors.text.tertiary,
                          lineHeight: 1,
                          fontSize: '13px',
                          opacity: trader.max_drawdown != null ? 1 : 0.5,
                        }}
                      >
                        {trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(0)}%` : '—'}
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
                padding: `${tokens.spacing[5]} ${tokens.spacing[4]}`,
                borderTop: `2px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: tokens.spacing[3],
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
                  const pages: (number | string)[] = []
                  
                  if (totalPages <= 7) {
                    for (let i = 1; i <= totalPages; i++) {
                      pages.push(i)
                    }
                  } else {
                    if (currentPage <= 3) {
                      for (let i = 1; i <= 5; i++) {
                        pages.push(i)
                      }
                      pages.push('...')
                      pages.push(totalPages)
                    } else if (currentPage >= totalPages - 2) {
                      pages.push(1)
                      pages.push('...')
                      for (let i = totalPages - 4; i <= totalPages; i++) {
                        pages.push(i)
                      }
                    } else {
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
                          minWidth: '40px',
                          height: '40px',
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
