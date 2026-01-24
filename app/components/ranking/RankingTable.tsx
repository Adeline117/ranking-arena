'use client'

import React, { useState, useEffect, useRef, memo, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../ui/Skeleton'
import { RankingBadge } from '../icons'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { ScoreRulesModal } from '../ui/ScoreRulesModal'
import CategoryRankingTabs, { CategoryType } from './CategoryRankingTabs'
import { ProLabel } from '../premium/PremiumGate'
import ExportButton from '../Utils/ExportButton'
import { VirtualList } from '../ui/VirtualList'

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

const SortIndicator = ({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) => (
  <svg width={8} height={10} viewBox="0 0 8 10" style={{ opacity: active ? 1 : 0.3, transition: 'opacity 0.2s', flexShrink: 0 }}>
    <path d="M4 0L7 4H1L4 0Z" fill="currentColor" opacity={dir === 'asc' && active ? 1 : 0.3} />
    <path d="M4 10L1 6H7L4 10Z" fill="currentColor" opacity={dir === 'desc' && active ? 1 : 0.3} />
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

/**
 * 获取 PnL 数据来源提示
 * 不同交易所的 PnL 含义不同：
 * - Binance: 交易员本人盈亏
 * - Bybit/Bitget/KuCoin/MEXC: 跟单者收益（非交易员本人）
 */
function getPnLTooltip(source: string, language: string): string {
  const traderPnlSources = ['binance', 'binance_futures', 'binance_spot', 'binance_web3']
  const followerPnlSources = ['bybit', 'bitget', 'bitget_futures', 'bitget_spot', 'kucoin', 'mexc']

  const sourceLower = source.toLowerCase()

  if (traderPnlSources.some(s => sourceLower.includes(s))) {
    return language === 'zh'
      ? 'PnL = 交易员本人盈亏'
      : 'PnL = Trader\'s own profit/loss'
  }

  if (followerPnlSources.some(s => sourceLower.includes(s))) {
    return language === 'zh'
      ? 'PnL = 跟单者收益（非交易员本人）'
      : 'PnL = Followers\' profit (not trader\'s own)'
  }

  return language === 'zh' ? 'PnL = 盈亏金额' : 'PnL = Profit/Loss'
}

// Column customization types
export type ColumnKey = 'score' | 'roi' | 'winrate' | 'mdd'

const ALL_TOGGLEABLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'winrate', 'mdd']
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'winrate', 'mdd']
const COLUMN_LABELS: Record<ColumnKey, { zh: string; en: string }> = {
  score: { zh: 'Arena Score', en: 'Arena Score' },
  roi: { zh: 'ROI', en: 'ROI' },
  winrate: { zh: '胜率', en: 'Win Rate' },
  mdd: { zh: '最大回撤', en: 'Max Drawdown' },
}
const LS_KEY_COLUMNS = 'ranking-visible-columns'

function getStoredColumns(): ColumnKey[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE_COLUMNS
  try {
    const stored = localStorage.getItem(LS_KEY_COLUMNS)
    if (stored) {
      const parsed = JSON.parse(stored) as ColumnKey[]
      if (Array.isArray(parsed) && parsed.every(c => ALL_TOGGLEABLE_COLUMNS.includes(c))) {
        return parsed
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_VISIBLE_COLUMNS
}

// Settings icon
const SettingsIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

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
  // Feature 3: Rank change indicators
  rank_change?: number | null // Positive = moved up
  is_new?: boolean // New to rankings
  // Feature 7: Duplicate trader detection
  also_on?: string[] // Other exchanges this trader appears on
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

// ============ Memoized Row Component ============

interface TraderRowProps {
  trader: Trader
  rank: number
  source?: string
  language: string
  getMedalGlowClass: (rank: number) => string
  parseSourceInfo: (src: string) => { exchange: string; type: string; typeColor: string }
  getPnLTooltipFn: (source: string, lang: string) => string
}

const TraderRow = memo(function TraderRow({
  trader,
  rank,
  source,
  language,
  getMedalGlowClass,
  parseSourceInfo,
  getPnLTooltipFn,
}: TraderRowProps) {
  const traderHandle = trader.handle || trader.id
  const href = `/trader/${encodeURIComponent(traderHandle)}`

  const formatDisplayName = (name: string) => {
    if (name.startsWith('0x') && name.length > 20) {
      return `${name.substring(0, 6)}...${name.substring(name.length - 4)}`
    }
    return name
  }

  const displayName = formatDisplayName(traderHandle)

  return (
    <Link
      href={href}
      className="ranking-row-link"
      style={{ textDecoration: 'none', display: 'block' }}
      aria-label={`#${rank} ${displayName}, ROI ${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}
      tabIndex={0}
    >
      <Box
        className="ranking-row ranking-table-grid ranking-table-grid-custom touch-target"
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
        {/* 排名 + Feature 3: Rank Change */}
        <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          {rank <= 3 ? (
            <Box className={getMedalGlowClass(rank)} style={{ transform: 'scale(1.1)' }}>
              <RankingBadge rank={rank as 1 | 2 | 3} size={28} />
            </Box>
          ) : (
            <Text size="sm" weight="bold" color="tertiary" style={{ fontSize: '14px' }}>
              #{rank}
            </Text>
          )}
          {trader.is_new ? (
            <span style={{ fontSize: '9px', fontWeight: 700, color: tokens.colors.accent.primary, lineHeight: 1 }}>NEW</span>
          ) : trader.rank_change != null && trader.rank_change !== 0 ? (
            <span style={{ fontSize: '9px', fontWeight: 700, color: trader.rank_change > 0 ? tokens.colors.accent.success : tokens.colors.accent.error, lineHeight: 1 }}>
              {trader.rank_change > 0 ? `+${trader.rank_change}` : trader.rank_change}
            </span>
          ) : null}
        </Box>

        {/* 交易员 */}
        <Box style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
          <div
            className="trader-avatar"
            style={{
              width: '36px', height: '36px', minWidth: '36px', minHeight: '36px',
              borderRadius: '50%', background: getAvatarGradient(trader.id),
              border: '2px solid var(--color-border-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden', flexShrink: 0, position: 'relative',
              boxShadow: rank <= 3 ? `0 0 12px ${rank === 1 ? 'rgba(255, 215, 0, 0.4)' : rank === 2 ? 'rgba(192, 192, 192, 0.4)' : 'rgba(205, 127, 50, 0.4)'}` : 'none',
            }}
          >
            <span style={{ color: '#ffffff', fontSize: '14px', fontWeight: 900, lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
              {getAvatarInitial(displayName)}
            </span>
            {trader.avatar_url && !trader.avatar_url.includes('t.co') && !trader.avatar_url.includes('/banner/') && (
              <img
                src={trader.avatar_url}
                alt={displayName}
                referrerPolicy="no-referrer"
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            )}
          </div>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px' }}>
                {displayName}
              </Text>
              {/* Feature 5: Mobile Score Badge - visible only on mobile */}
              {trader.arena_score != null && (
                <span className="mobile-score-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: trader.arena_score >= 60 ? tokens.colors.accent.success : trader.arena_score >= 40 ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
                  }} />
                  <span style={{ fontSize: '11px', fontWeight: 700, color: tokens.colors.text.secondary }}>{trader.arena_score.toFixed(0)}</span>
                </span>
              )}
            </Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {(() => {
                const info = parseSourceInfo(trader.source || source || '')
                return (
                  <Box style={{ padding: '2px 6px', borderRadius: tokens.radius.sm, background: `${info.typeColor}15`, border: `1px solid ${info.typeColor}30` }}>
                    <Text size="xs" weight="bold" style={{ color: info.typeColor, fontSize: '10px', lineHeight: 1.2 }}>
                      {info.type}
                    </Text>
                  </Box>
                )
              })()}
              {/* Feature 7: Also on other exchanges */}
              {trader.also_on && trader.also_on.length > 0 && (
                <Text size="xs" style={{ fontSize: '9px', color: tokens.colors.text.tertiary, lineHeight: 1.2 }}>
                  also on: {trader.also_on.map(s => s.split('_')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                </Text>
              )}
            </Box>
          </Box>
        </Box>

        {/* Arena Score + Feature 10: Score Breakdown Tooltip */}
        <Box className="col-score" style={{ textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <Box style={{
            position: 'relative', minWidth: 46, height: 24, borderRadius: tokens.radius.md,
            background: trader.arena_score != null && trader.arena_score >= 60 ? tokens.gradient.successSubtle : trader.arena_score != null && trader.arena_score >= 40 ? tokens.gradient.warningSubtle : tokens.glass.bg.light,
            border: `1px solid ${trader.arena_score != null && trader.arena_score >= 60 ? `${tokens.colors.accent.success}50` : trader.arena_score != null && trader.arena_score >= 40 ? `${tokens.colors.accent.warning}40` : 'rgba(255, 255, 255, 0.15)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}>
            {trader.arena_score != null && (
              <Box style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${trader.arena_score}%`, background: trader.arena_score >= 60 ? `${tokens.colors.accent.success}20` : trader.arena_score >= 40 ? `${tokens.colors.accent.warning}20` : `${tokens.colors.accent.primary}15`, transition: 'width 0.3s ease' }} />
            )}
            <Text size="sm" weight="black" style={{ position: 'relative', color: trader.arena_score != null && trader.arena_score >= 60 ? tokens.colors.accent.success : trader.arena_score != null && trader.arena_score >= 40 ? tokens.colors.accent.warning : tokens.colors.text.secondary, fontSize: '12px', lineHeight: 1 }}>
              {trader.arena_score != null ? trader.arena_score.toFixed(1) : '—'}
            </Text>
          </Box>
          <ScoreBreakdownTooltip trader={trader} language={language} />
        </Box>

        {/* ROI */}
        <Box className="roi-cell" style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <Text size="md" weight="black" className="roi-value" style={{ color: (trader.roi || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error, lineHeight: 1.2, fontSize: '16px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${(trader.roi || 0) >= 0 ? '+' : ''}${(trader.roi || 0).toFixed(2)}%`}>
            {formatROI(trader.roi || 0)}
          </Text>
          <Text size="xs" weight="semibold" className="pnl-value" style={{ color: trader.pnl != null ? (trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.tertiary, lineHeight: 1.2, fontSize: '12px', opacity: trader.pnl != null ? 0.85 : 0.5, cursor: trader.pnl != null ? 'help' : 'default' }} title={trader.pnl != null ? getPnLTooltipFn(trader.source || source || '', language) : undefined}>
            {trader.pnl != null ? `${trader.pnl >= 0 ? '+' : ''}${formatPnL(trader.pnl)}` : '—'}
          </Text>
        </Box>

        {/* Win% */}
        <Box className="col-winrate" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          <Text size="sm" weight="semibold" style={{ color: trader.win_rate != null && trader.win_rate > 0.5 ? tokens.colors.accent.success : tokens.colors.text.secondary, lineHeight: 1, fontSize: '13px' }}>
            {trader.win_rate != null ? `${trader.win_rate.toFixed(0)}%` : '—'}
          </Text>
        </Box>

        {/* MDD */}
        <Box className="col-mdd" style={{ textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }}>
          <Text size="sm" weight="semibold" style={{ color: trader.max_drawdown != null ? tokens.colors.accent.error : tokens.colors.text.tertiary, lineHeight: 1, fontSize: '13px', opacity: trader.max_drawdown != null ? 1 : 0.5 }}>
            {trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(0)}%` : '—'}
          </Text>
        </Box>
      </Box>
    </Link>
  )
}, (prev, next) => {
  // 自定义比较：只在关键数据变化时重新渲染
  return (
    prev.trader.id === next.trader.id &&
    prev.trader.roi === next.trader.roi &&
    prev.trader.arena_score === next.trader.arena_score &&
    prev.trader.pnl === next.trader.pnl &&
    prev.trader.win_rate === next.trader.win_rate &&
    prev.trader.max_drawdown === next.trader.max_drawdown &&
    prev.trader.rank_change === next.trader.rank_change &&
    prev.trader.is_new === next.trader.is_new &&
    prev.rank === next.rank &&
    prev.language === next.language
  )
})

// Feature 2: Search icon
const SearchIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" strokeLinecap="round" />
  </svg>
)

// Feature 10: Score Breakdown Tooltip
const ScoreBreakdownTooltip = memo(function ScoreBreakdownTooltip({
  trader,
  language,
}: {
  trader: Trader
  language: string
}) {
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  if (trader.return_score == null && trader.drawdown_score == null && trader.stability_score == null) {
    return null
  }

  return (
    <div
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShow(s => !s) }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5, cursor: 'pointer' }}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
      </svg>
      {show && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: 6,
            padding: '8px 12px',
            background: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            boxShadow: tokens.shadow.lg,
            zIndex: 100,
            whiteSpace: 'nowrap',
            fontSize: '11px',
            lineHeight: 1.6,
            color: tokens.colors.text.secondary,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2, color: tokens.colors.text.primary }}>
            {language === 'zh' ? '分数构成' : 'Score Breakdown'}
          </div>
          <div>{language === 'zh' ? '收益' : 'Return'}: <span style={{ color: tokens.colors.accent.success, fontWeight: 700 }}>{trader.return_score?.toFixed(1) ?? '—'}</span>/85</div>
          <div>{language === 'zh' ? '回撤' : 'Drawdown'}: <span style={{ color: tokens.colors.accent.warning, fontWeight: 700 }}>{trader.drawdown_score?.toFixed(1) ?? '—'}</span>/8</div>
          <div>{language === 'zh' ? '稳定' : 'Stability'}: <span style={{ color: tokens.colors.accent.primary, fontWeight: 700 }}>{trader.stability_score?.toFixed(1) ?? '—'}</span>/7</div>
        </div>
      )}
    </div>
  )
})

// Feature 2: Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
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
  onFilterToggle?: () => void // 高级筛选切换回调
  hasActiveFilters?: boolean // 是否有活动的高级筛选
  error?: string | null // 错误信息
  onRetry?: () => void // 重试回调
  // Feature 8: Controlled props for URL-first state
  controlledSortColumn?: 'score' | 'roi' | 'winrate' | 'mdd'
  controlledSortDir?: 'asc' | 'desc'
  controlledPage?: number
  controlledSearchQuery?: string
  onSortChange?: (column: 'score' | 'roi' | 'winrate' | 'mdd', dir: 'asc' | 'desc') => void
  onPageChange?: (page: number) => void
  onSearchChange?: (query: string) => void
}) {
  const { traders, loading, source, timeRange = '90D', isPro = false, category = 'all', onCategoryChange, onProRequired, onFilterToggle, hasActiveFilters, error, onRetry,
    controlledSortColumn, controlledSortDir, controlledPage, controlledSearchQuery,
    onSortChange, onPageChange, onSearchChange,
  } = props
  const { t, language } = useLanguage()
  const router = useRouter()

  // 分页状态 (internal state, overridden by controlled props)
  const [internalPage, setInternalPage] = useState(1)
  const [showRules, setShowRules] = useState(false)
  const [showScoreRulesModal, setShowScoreRulesModal] = useState(false)
  const [internalSortColumn, setInternalSortColumn] = useState<'score' | 'roi' | 'winrate' | 'mdd'>('score')
  const [internalSortDir, setInternalSortDir] = useState<'asc' | 'desc'>('desc')
  const itemsPerPage = 20 // 每页显示 20 条

  // Feature 2: Inline search state
  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const searchQuery = controlledSearchQuery ?? internalSearchQuery
  const debouncedSearch = useDebounce(searchQuery, 300)

  // Feature 8: Use controlled or internal state
  const sortColumn = controlledSortColumn ?? internalSortColumn
  const sortDir = controlledSortDir ?? internalSortDir
  const currentPage = controlledPage ?? internalPage
  const setCurrentPage = useCallback((v: number | ((prev: number) => number)) => {
    const newVal = typeof v === 'function' ? v(controlledPage ?? internalPage) : v
    if (onPageChange) onPageChange(newVal)
    else setInternalPage(newVal)
  }, [onPageChange, controlledPage, internalPage])

  // Column customization
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_VISIBLE_COLUMNS)
  const [showColumnSettings, setShowColumnSettings] = useState(false)

  // Load stored columns on mount
  useEffect(() => {
    setVisibleColumns(getStoredColumns())
  }, [])

  const toggleColumn = (col: ColumnKey) => {
    setVisibleColumns(prev => {
      const next = prev.includes(col)
        ? prev.filter(c => c !== col)
        : [...prev, col]
      // Ensure at least one column is visible
      if (next.length === 0) return prev
      localStorage.setItem(LS_KEY_COLUMNS, JSON.stringify(next))
      return next
    })
  }

  const resetColumns = () => {
    setVisibleColumns(DEFAULT_VISIBLE_COLUMNS)
    localStorage.setItem(LS_KEY_COLUMNS, JSON.stringify(DEFAULT_VISIBLE_COLUMNS))
  }

  // Compute dynamic grid template for desktop based on visible columns
  const desktopGridTemplate = React.useMemo(() => {
    let template = '44px minmax(140px, 1.5fr)' // Rank + Trader (always visible)
    if (visibleColumns.includes('score')) template += ' 64px'
    if (visibleColumns.includes('roi')) template += ' 90px'
    if (visibleColumns.includes('winrate')) template += ' 70px'
    if (visibleColumns.includes('mdd')) template += ' 70px'
    return template
  }, [visibleColumns])

  // Virtual scrolling ref
  const virtualListRef = useRef<HTMLDivElement>(null)

  // Inject styles on mount
  useEffect(() => {
    injectStyles()
  }, [])

  const handleSort = (col: 'score' | 'roi' | 'winrate' | 'mdd') => {
    const newDir = sortColumn === col ? (sortDir === 'desc' ? 'asc' : 'desc') : 'desc'
    if (onSortChange) {
      onSortChange(col, newDir)
    } else {
      setInternalSortColumn(col)
      setInternalSortDir(newDir)
    }
    setCurrentPage(1)
  }

  // Feature 2: Handle search input
  const handleSearchInput = (value: string) => {
    if (onSearchChange) onSearchChange(value)
    else setInternalSearchQuery(value)
    setCurrentPage(1)
  }

  // Feature 2: Filter by search, then sort
  const sortedTraders = React.useMemo(() => {
    let data = traders.slice(0, 100)

    // Feature 2: Apply search filter
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase()
      data = data.filter(t => {
        const handle = (t.handle || t.id || '').toLowerCase()
        return handle.includes(q) || t.id.toLowerCase().includes(q)
      })
    }

    return [...data].sort((a, b) => {
      let aVal = 0, bVal = 0
      switch (sortColumn) {
        case 'score': aVal = a.arena_score ?? 0; bVal = b.arena_score ?? 0; break
        case 'roi': aVal = a.roi ?? 0; bVal = b.roi ?? 0; break
        case 'winrate': aVal = a.win_rate ?? 0; bVal = b.win_rate ?? 0; break
        case 'mdd': aVal = Math.abs(a.max_drawdown ?? 0); bVal = Math.abs(b.max_drawdown ?? 0); break
      }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal
    })
  }, [traders, sortColumn, sortDir, debouncedSearch])

  // Virtual scrolling for large datasets
  const useVirtualScroll = sortedTraders.length > 50

  // Scroll to top when sort changes (for virtual list)
  useEffect(() => {
    if (useVirtualScroll && virtualListRef.current) {
      const scrollContainer = virtualListRef.current.querySelector('[style*="overflow"]') as HTMLElement
      if (scrollContainer) scrollContainer.scrollTop = 0
    }
  }, [sortColumn, sortDir, useVirtualScroll])

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
    const exchange = parts[0]
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
    <>
    {/* Dynamic grid template override for column customization */}
    <style>{`
      @media (min-width: 768px) {
        .ranking-table-grid-custom {
          grid-template-columns: ${desktopGridTemplate} !important;
        }
        ${!visibleColumns.includes('score') ? '.ranking-table-grid-custom .col-score { display: none !important; }' : ''}
        ${!visibleColumns.includes('winrate') ? '.ranking-table-grid-custom .col-winrate { display: none !important; }' : ''}
        ${!visibleColumns.includes('mdd') ? '.ranking-table-grid-custom .col-mdd { display: none !important; }' : ''}
        ${!visibleColumns.includes('roi') ? '.ranking-table-grid-custom .roi-cell { display: none !important; }' : ''}
      }
    `}</style>
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
      {/* Category Tabs */}
      {onCategoryChange && (
        <Box
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            borderBottom: `1px solid var(--glass-border-light)`,
            background: tokens.glass.bg.light,
            borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
            flexWrap: 'wrap',
          }}
        >
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
      )}

      {/* 工具按钮行 - 筛选 对比 设置 */}
      <Box
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          borderBottom: `1px solid var(--glass-border-light)`,
          background: tokens.glass.bg.light,
        }}
      >
        {/* 高级筛选按钮 */}
        <Box
          onClick={isPro ? onFilterToggle : onProRequired}
          title={language === 'en' ? 'Advanced Filter' : '高级筛选'}
          className="touch-target-sm"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            height: 28,
            borderRadius: tokens.radius.md,
            position: 'relative',
            background: hasActiveFilters ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)',
            border: hasActiveFilters ? '1px solid var(--color-pro-gradient-start)' : '1px solid var(--color-border-secondary)',
            color: hasActiveFilters ? 'var(--color-pro-gradient-start)' : isPro ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
            cursor: isPro ? 'pointer' : 'not-allowed',
            transition: 'all 0.2s',
            opacity: isPro ? 1 : 0.5,
            fontSize: tokens.typography.fontSize.xs,
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
          <FilterIcon size={12} />
          <span>{language === 'zh' ? '筛选' : 'Filter'}</span>
          {!isPro && <LockIconSmall size={8} />}
          {hasActiveFilters && (
            <Box style={{
              position: 'absolute',
              top: 2,
              right: 2,
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: tokens.colors.accent.primary,
            }} />
          )}
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
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            height: 28,
            borderRadius: tokens.radius.md,
            background: isPro ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)',
            border: isPro ? '1px solid var(--color-pro-gradient-start)' : '1px solid var(--color-border-secondary)',
            color: isPro ? 'var(--color-pro-gradient-start)' : 'var(--color-text-tertiary)',
            textDecoration: 'none',
            cursor: isPro ? 'pointer' : 'not-allowed',
            transition: 'all 0.2s',
            opacity: isPro ? 1 : 0.5,
            fontSize: tokens.typography.fontSize.xs,
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
          <CompareIcon size={12} />
          <span>{language === 'zh' ? '对比' : 'Compare'}</span>
          {!isPro && <LockIconSmall size={8} />}
        </Link>

        {/* 列设置按钮 */}
        <Box style={{ position: 'relative' }}>
          <Box
            onClick={() => setShowColumnSettings(!showColumnSettings)}
            title={language === 'en' ? 'Column Settings' : '列设置'}
            className="touch-target-sm"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              height: 28,
              borderRadius: tokens.radius.md,
              background: showColumnSettings ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)',
              border: showColumnSettings ? '1px solid var(--color-pro-gradient-start)' : '1px solid var(--color-border-secondary)',
              color: showColumnSettings ? 'var(--color-pro-gradient-start)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              transition: 'all 0.2s',
              fontSize: tokens.typography.fontSize.xs,
            }}
          >
            <SettingsIcon size={12} />
            <span>{language === 'zh' ? '设置' : 'Settings'}</span>
          </Box>
          {/* Column Settings Dropdown */}
          {showColumnSettings && (
            <Box
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: tokens.spacing[1],
                padding: tokens.spacing[3],
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.lg,
                boxShadow: tokens.shadow.lg,
                zIndex: 9999,
                minWidth: 180,
              }}
              onClick={(e) => e.stopPropagation()}
            >
                  <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                    {language === 'zh' ? '列设置' : 'Column Settings'}
                  </Text>
                  {ALL_TOGGLEABLE_COLUMNS.map(col => (
                    <label
                      key={col}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        padding: `${tokens.spacing[1]} 0`,
                        cursor: 'pointer',
                        fontSize: tokens.typography.fontSize.sm,
                        color: tokens.colors.text.primary,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(col)}
                        onChange={() => toggleColumn(col)}
                        style={{ cursor: 'pointer' }}
                      />
                      {language === 'zh' ? COLUMN_LABELS[col].zh : COLUMN_LABELS[col].en}
                    </label>
                  ))}
                  <button
                    onClick={resetColumns}
                    style={{
                      marginTop: tokens.spacing[2],
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.accent.primary,
                      background: 'transparent',
                      border: `1px solid ${tokens.colors.accent.primary}40`,
                      borderRadius: tokens.radius.sm,
                      cursor: 'pointer',
                      width: '100%',
                    }}
                  >
                    {language === 'zh' ? '恢复默认' : 'Reset to Default'}
                  </button>
                </Box>
              )}
            </Box>

        {/* 导出按钮 */}
        {isPro && traders.length > 0 && (
          <ExportButton
            data={traders.map(t => ({
              rank: traders.indexOf(t) + 1,
              handle: t.handle || t.id,
              source: t.source || '',
              arena_score: t.arena_score ?? '',
              roi: t.roi,
              pnl: t.pnl ?? '',
              win_rate: t.win_rate ?? '',
              max_drawdown: t.max_drawdown ?? '',
              followers: t.followers,
            }))}
            filename={`ranking-arena-${source || 'all'}-${timeRange || '90D'}`}
            format="csv"
          />
        )}
      </Box>

      {/* Feature 2: Inline Table Search */}
      <Box
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid var(--glass-border-light)`,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
        }}
      >
        <SearchIcon size={14} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearchInput(e.target.value)}
          placeholder={language === 'zh' ? '搜索交易员...' : 'Search traders...'}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            padding: `${tokens.spacing[1]} 0`,
          }}
        />
        {debouncedSearch.trim() && (
          <Text size="xs" color="tertiary" style={{ flexShrink: 0 }}>
            {sortedTraders.length} {language === 'zh' ? '条结果' : 'results'}
          </Text>
        )}
        {searchQuery && (
          <button
            onClick={() => handleSearchInput('')}
            style={{ background: 'none', border: 'none', color: tokens.colors.text.tertiary, cursor: 'pointer', padding: 4, lineHeight: 1, fontSize: '16px' }}
          >
            ×
          </button>
        )}
      </Box>

      {/* Header - 增大字体和间距 */}
      <Box
        className="ranking-table-header ranking-table-grid ranking-table-grid-custom"
        style={{
          display: 'grid',
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
        <Box
          className="col-score"
          as="button"
          onClick={() => handleSort('score')}
          title={language === 'zh' ? 'Arena Score: 综合评分 (0-100)' : 'Arena Score: Overall rating (0-100)'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'score' ? tokens.colors.accent.primary : tokens.colors.text.tertiary }}
        >
          Score <SortIndicator active={sortColumn === 'score'} dir={sortDir} />
        </Box>
        <Box
          className="roi-cell"
          as="button"
          onClick={() => handleSort('roi')}
          title={language === 'zh' ? `ROI: 投资回报率 (${timeRange})` : `ROI: Return on Investment (${timeRange})`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'roi' ? tokens.colors.accent.primary : tokens.colors.text.tertiary }}
        >
          ROI <SortIndicator active={sortColumn === 'roi'} dir={sortDir} />
        </Box>
        <Box
          className="col-winrate"
          as="button"
          onClick={() => handleSort('winrate')}
          title={language === 'zh' ? 'Win%: 胜率' : 'Win%: Win Rate'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'winrate' ? tokens.colors.accent.primary : tokens.colors.text.tertiary }}
        >
          Win% <SortIndicator active={sortColumn === 'winrate'} dir={sortDir} />
        </Box>
        <Box
          className="col-mdd"
          as="button"
          onClick={() => handleSort('mdd')}
          title={language === 'zh' ? 'MDD: 最大回撤' : 'MDD: Max Drawdown'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'mdd' ? tokens.colors.accent.primary : tokens.colors.text.tertiary }}
        >
          MDD <SortIndicator active={sortColumn === 'mdd'} dir={sortDir} />
        </Box>
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
            {language === 'zh' ? 'Arena Score 排名规则' : 'Arena Score Ranking Rules'}
          </Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>{language === 'zh' ? '① 按 Arena Score 从高到低排序（0-100 分）' : '① Ranked by Arena Score (0-100)'}</span>
            <span>{language === 'zh' ? '② 分数构成：收益分（85%）+ 稳定/风险分（15%）' : '② Score: Return (85%) + Stability/Risk (15%)'}</span>
            <span>{language === 'zh' ? '③ Score 相同时，回撤更小的靠前' : '③ Lower drawdown ranks higher when Score ties'}</span>
            <span style={{ color: tokens.colors.text.tertiary, marginTop: 6 }}>
              {language === 'zh'
                ? '* 入榜门槛（PNL 收益）：7D > $300 | 30D > $1,000 | 90D > $3,000'
                : '* Entry threshold (PNL): 7D > $300 | 30D > $1,000 | 90D > $3,000'}
            </span>
            <span style={{ color: tokens.colors.text.tertiary, marginTop: 4 }}>
              {language === 'zh'
                ? '* ROI 计算方式因交易所而异，跨所对比时请注意差异'
                : '* ROI calculation varies by exchange. Use caution when comparing across exchanges.'}
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
      ) : error ? (
        <Box
          style={{
            padding: `${tokens.spacing[10]} ${tokens.spacing[4]}`,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: tokens.spacing[3],
          }}
        >
          <Text size="md" color="secondary">
            {error}
          </Text>
          {onRetry && (
            <button
              onClick={onRetry}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                background: `${tokens.colors.accent.primary}20`,
                border: `1px solid ${tokens.colors.accent.primary}40`,
                borderRadius: tokens.radius.md,
                color: tokens.colors.accent.primary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.bold,
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${tokens.colors.accent.primary}30`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `${tokens.colors.accent.primary}20`
              }}
            >
              {t('retry') || '重试'}
            </button>
          )}
        </Box>
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
      ) : useVirtualScroll ? (
        /* Virtual scrolling for large datasets (>50 traders) */
        <div ref={virtualListRef}>
          <VirtualList
            items={sortedTraders}
            itemHeight={72}
            height={600}
            overscan={5}
            keyExtractor={(trader, idx) => `${trader.id}-${trader.source || 'unknown'}-${idx}`}
            renderItem={(trader, idx) => (
              <TraderRow
                trader={trader}
                rank={idx + 1}
                source={source}
                language={language}
                getMedalGlowClass={getMedalGlowClass}
                parseSourceInfo={parseSourceInfo}
                getPnLTooltipFn={getPnLTooltip}
              />
            )}
          />
        </div>
      ) : (
        <>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {paginatedTraders.map((trader, idx) => {
              const rank = startIndex + idx + 1
              const uniqueKey = `${trader.id}-${trader.source || 'unknown'}-${startIndex + idx}`

              return (
                <TraderRow
                  key={uniqueKey}
                  trader={trader}
                  rank={rank}
                  source={source}
                  language={language}
                  getMedalGlowClass={getMedalGlowClass}
                  parseSourceInfo={parseSourceInfo}
                  getPnLTooltipFn={getPnLTooltip}
                />
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
    </>
  )
}
