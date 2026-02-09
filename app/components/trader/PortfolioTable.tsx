'use client'

import { useState, useEffect, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import type { PortfolioItem, PositionHistoryItem } from '@/lib/data/trader'

// 扩展的仓位历史类型
interface ExtendedPositionHistoryItem extends PositionHistoryItem {
  positionType?: string
  marginMode?: string
  maxPositionSize?: number
  closedSize?: number
  pnlUsd?: number
  status?: string
}

interface PortfolioTableProps {
  items: PortfolioItem[]
  history?: (PositionHistoryItem | ExtendedPositionHistoryItem)[]
  isPro?: boolean
  onUnlock?: () => void
}

type ViewMode = 'current' | 'history'

/**
 * Portfolio页面 - 显示当前持仓和历史仓位
 * 现代化设计，流畅动画
 */
export default function PortfolioTable({ items, history = [], isPro = true, onUnlock }: PortfolioTableProps) {
  const { t } = useLanguage()
  const [viewMode, setViewMode] = useState<ViewMode>('current')
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'openTime' | 'closeTime' | 'pnl'>('openTime')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [mounted, setMounted] = useState(false)
  const [hoveredRow, setHoveredRow] = useState<number | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  
  // 默认只显示3条，展开后显示全部
  const COLLAPSED_COUNT = 3

  useEffect(() => {
    setMounted(true)
  }, [])

  // 排序历史记录
  const sortedHistory = [...history].sort((a, b) => {
    let aValue: number, bValue: number
    
    if (sortBy === 'pnl') {
      aValue = a.pnlPct || 0
      bValue = b.pnlPct || 0
    } else if (sortBy === 'closeTime') {
      aValue = a.closeTime ? new Date(a.closeTime).getTime() : 0
      bValue = b.closeTime ? new Date(b.closeTime).getTime() : 0
    } else {
      aValue = a.openTime ? new Date(a.openTime).getTime() : 0
      bValue = b.openTime ? new Date(b.openTime).getTime() : 0
    }
    
    return sortOrder === 'desc' ? bValue - aValue : aValue - bValue
  })

  // 检查是否有扩展字段
  const hasExtendedFields = history.some(item => 
    'positionType' in item || 'maxPositionSize' in item || 'pnlUsd' in item
  )

  return (
    <>
      <Box
        className="portfolio-table glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}60`,
          overflow: 'hidden',
          boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(20px)',
          transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          position: 'relative',
        }}
      >
        {/* Pro Lock Overlay - shows UI but blurs content */}
        {!isPro && (
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <Box
              style={{
                background: `linear-gradient(135deg, ${tokens.colors.bg.primary}F0, ${tokens.colors.bg.secondary}E8)`,
                backdropFilter: 'blur(4px)',
                borderRadius: tokens.radius.xl,
                padding: tokens.spacing[6],
                border: `1px solid ${tokens.colors.accent.primary}40`,
                boxShadow: `0 8px 32px var(--color-accent-primary-20)`,
                textAlign: 'center',
                pointerEvents: 'auto',
                maxWidth: 360,
              }}
            >
              <Box style={{
                width: 48,
                height: 48,
                borderRadius: tokens.radius.full,
                background: `linear-gradient(135deg, ${tokens.colors.accent.primary}30, ${tokens.colors.accent.brand}20)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
                marginBottom: tokens.spacing[4],
              }}>
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </Box>
              <Text size="lg" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: tokens.spacing[2] }}>
                {t('unlockFullPortfolio')}
              </Text>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
                {t('unlockFullPortfolioDesc')}
              </Text>
              {onUnlock && (
                <button
                  onClick={onUnlock}
                  style={{
                    padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
                    borderRadius: tokens.radius.lg,
                    border: 'none',
                    background: `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
                    color: tokens.colors.white,
                    fontWeight: tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                    transition: 'all 0.25s ease',
                    fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  }}
                >
                  {t('upgradeToProBtn')}
                </button>
              )}
            </Box>
          </Box>
        )}

        {/* Header */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: tokens.spacing[5],
            borderBottom: `1px solid ${tokens.colors.border.primary}40`,
            background: `linear-gradient(180deg, ${tokens.colors.bg.secondary} 0%, transparent 100%)`,
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
              {t('portfolio')}
            </Text>
          </Box>
          
          {/* View Mode Toggle */}
          <Box
            style={{
              display: 'flex',
              gap: 2,
              background: tokens.colors.bg.tertiary,
              padding: 3,
              borderRadius: tokens.radius.lg,
            }}
          >
            <button
              onClick={() => setViewMode('current')}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: viewMode === 'current' 
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
                  : 'transparent',
                color: viewMode === 'current' ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: viewMode === 'current' ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                cursor: 'pointer',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
              }}
            >
              {t('current')}
            </button>
            <button
              onClick={() => setViewMode('history')}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: viewMode === 'history' 
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
                  : 'transparent',
                color: viewMode === 'history' ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: viewMode === 'history' ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                cursor: 'pointer',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
              }}
            >
              {t('positionHistory')}
            </button>
          </Box>
        </Box>

        {/* Content */}
        <Box style={{ padding: tokens.spacing[5], filter: isPro ? 'none' : 'blur(6px)', pointerEvents: isPro ? 'auto' : 'none' }}>
          {viewMode === 'current' ? (
            // Current Holdings
            items.length > 0 ? (
              <Box className="portfolio-table-scroll" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, textAlign: 'left' }}>{t('market')}</th>
                      <th style={{ ...thStyle, textAlign: 'left' }}>{t('direction')}</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>{t('weight')}</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>{t('pnl')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => (
                      <tr
                        key={idx}
                        className="portfolio-row"
                        style={{
                          cursor: 'pointer',
                          background: hoveredRow === idx 
                            ? `${tokens.colors.accent.primary}08` 
                            : (selectedMarket === item.market ? tokens.colors.bg.tertiary : 'transparent'),
                          transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                          borderLeft: hoveredRow === idx ? `3px solid ${tokens.colors.accent.primary}` : '3px solid transparent',
                        }}
                        onClick={() => setSelectedMarket(selectedMarket === item.market ? null : item.market)}
                        onMouseEnter={() => setHoveredRow(idx)}
                        onMouseLeave={() => setHoveredRow(null)}
                      >
                        <td style={{ padding: tokens.spacing[4] }}>
                          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                            {/* 币种图标 */}
                            <CryptoIcon symbol={item.market} size={28} />
                            <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                              {item.market}
                            </Text>
                          </Box>
                        </td>
                        <td style={{ padding: tokens.spacing[4] }}>
                          <Box style={{ 
                            display: 'inline-flex',
                            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                            borderRadius: tokens.radius.full,
                            background: item.direction === 'long' 
                              ? `linear-gradient(135deg, ${tokens.colors.accent.success}20, ${tokens.colors.accent.success}10)`
                              : `linear-gradient(135deg, ${tokens.colors.accent.error}20, ${tokens.colors.accent.error}10)`,
                            border: `1px solid ${item.direction === 'long' ? tokens.colors.accent.success : tokens.colors.accent.error}30`,
                          }}>
                            <Text size="xs" style={{ 
                              color: item.direction === 'long' ? tokens.colors.accent.success : tokens.colors.accent.error,
                              fontWeight: tokens.typography.fontWeight.bold,
                            }}>
                              {item.direction === 'long' ? t('long') : t('short')}
                            </Text>
                          </Box>
                        </td>
                        <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                          {/* Progress Bar */}
                          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: tokens.spacing[2] }}>
                            <Box
                              style={{
                                width: 60,
                                height: 6,
                                background: tokens.colors.bg.tertiary,
                                borderRadius: tokens.radius.full,
                                overflow: 'hidden',
                              }}
                            >
                              <Box
                                style={{
                                  height: '100%',
                                  width: `${Math.min(item.invested, 100)}%`,
                                  background: `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
                                  borderRadius: tokens.radius.full,
                                  transition: 'width 0.5s ease',
                                }}
                              />
                            </Box>
                            <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary, minWidth: 40, textAlign: 'right' }}>
                              {item.invested.toFixed(1)}%
                            </Text>
                          </Box>
                        </td>
                        <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                          <Text
                            size="sm"
                            weight="black"
                            style={{ 
                              color: item.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                              fontFamily: tokens.typography.fontFamily.mono.join(', '),
                            }}
                          >
                            {item.pnl >= 0 ? '+' : ''}{item.pnl.toFixed(2)}%
                          </Text>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            ) : (
              <EmptyState 
                message={t('noCurrentPositions')} 
                subMessage={t('noCurrentPositionsDesc')} 
              />
            )
          ) : (
            // Position History
            sortedHistory.length > 0 ? (
              <Box>
                {/* Sort Controls */}
                <Box style={{ 
                  display: 'flex', 
                  justifyContent: 'flex-end', 
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  marginBottom: tokens.spacing[4],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  background: tokens.colors.bg.tertiary,
                  borderRadius: tokens.radius.lg,
                }}>
                  <Text size="xs" color="tertiary">{t('sortBy')}</Text>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as 'openTime' | 'closeTime' | 'pnl')}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: tokens.colors.bg.primary,
                      color: tokens.colors.text.primary,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      fontFamily: tokens.typography.fontFamily.sans.join(', '),
                    }}
                  >
                    <option value="openTime">{t('openTime')}</option>
                    <option value="closeTime">{t('closeTime')}</option>
                    <option value="pnl">{t('pnl')}</option>
                  </select>
                  <button
                    onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: tokens.colors.bg.primary,
                      color: tokens.colors.text.primary,
                      fontSize: tokens.typography.fontSize.sm,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      fontFamily: tokens.typography.fontFamily.sans.join(', '),
                    }}
                  >
                    {sortOrder === 'desc' ? t('descending') : t('ascending')}
                  </button>
                </Box>

                {/* History List */}
                {hasExtendedFields ? (
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                    {(historyExpanded ? sortedHistory : sortedHistory.slice(0, COLLAPSED_COUNT)).map((item, idx) => (
                      <PositionHistoryCard 
                        key={idx} 
                        position={item as ExtendedPositionHistoryItem} 
                        index={idx}
                      />
                    ))}
                    {sortedHistory.length > COLLAPSED_COUNT && (
                      <button
                        onClick={() => setHistoryExpanded(!historyExpanded)}
                        style={{
                          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                          borderRadius: tokens.radius.lg,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          background: tokens.colors.bg.tertiary,
                          color: tokens.colors.text.secondary,
                          fontSize: tokens.typography.fontSize.sm,
                          fontWeight: tokens.typography.fontWeight.medium,
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          fontFamily: tokens.typography.fontFamily.sans.join(', '),
                          width: '100%',
                          textAlign: 'center',
                        }}
                      >
                        {historyExpanded ? t('collapse') : `${t('expandAll')} (${sortedHistory.length})`}
                      </button>
                    )}
                  </Box>
                ) : (
                  <Box>
                    <Box className="portfolio-table-scroll" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
                        <thead>
                          <tr>
                            <th style={{ ...thStyle, textAlign: 'left' }}>{t('symbol')}</th>
                            <th style={{ ...thStyle, textAlign: 'left' }}>{t('direction')}</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>{t('entryPrice')}</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>{t('exitPrice')}</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>{t('pnl')}</th>
                            <th style={{ ...thStyle, textAlign: 'right' }}>{t('closeTime')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(historyExpanded ? sortedHistory : sortedHistory.slice(0, COLLAPSED_COUNT)).map((item, idx) => (
                            <tr
                              key={idx}
                              className="portfolio-row"
                              style={{
                                background: hoveredRow === 100 + idx ? `${tokens.colors.accent.primary}05` : 'transparent',
                                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                              }}
                              onMouseEnter={() => setHoveredRow(100 + idx)}
                              onMouseLeave={() => setHoveredRow(null)}
                            >
                              <td style={{ padding: tokens.spacing[4] }}>
                                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                                  <CryptoIcon symbol={item.symbol} size={20} />
                                  <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                                    {item.symbol}
                                  </Text>
                                </Box>
                              </td>
                              <td style={{ padding: tokens.spacing[4] }}>
                                <Box style={{ 
                                  display: 'inline-flex',
                                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                                  borderRadius: tokens.radius.full,
                                  background: item.direction === 'long' ? `${tokens.colors.accent.success}15` : `${tokens.colors.accent.error}15`,
                                }}>
                                  <Text size="xs" style={{ 
                                    color: item.direction === 'long' ? tokens.colors.accent.success : tokens.colors.accent.error,
                                    fontWeight: tokens.typography.fontWeight.bold,
                                  }}>
                                    {item.direction === 'long' ? t('long') : t('short')}
                                  </Text>
                                </Box>
                              </td>
                              <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                                <Text size="sm" style={{ color: tokens.colors.text.secondary, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                                  {formatPrice(item.entryPrice)}
                                </Text>
                              </td>
                              <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                                <Text size="sm" style={{ color: tokens.colors.text.secondary, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                                  {formatPrice(item.exitPrice)}
                                </Text>
                              </td>
                              <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                                <Text
                                  size="sm"
                                  weight="bold"
                                  style={{ 
                                    color: item.pnlPct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                                    fontFamily: tokens.typography.fontFamily.mono.join(', '),
                                  }}
                                >
                                  {item.pnlPct >= 0 ? '+' : ''}{item.pnlPct.toFixed(2)}%
                                </Text>
                              </td>
                              <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                                <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                                  {item.closeTime ? formatDateTime(item.closeTime) : '-'}
                                </Text>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Box>
                    {sortedHistory.length > COLLAPSED_COUNT && (
                      <button
                        onClick={() => setHistoryExpanded(!historyExpanded)}
                        style={{
                          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                          borderRadius: tokens.radius.lg,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          background: tokens.colors.bg.tertiary,
                          color: tokens.colors.text.secondary,
                          fontSize: tokens.typography.fontSize.sm,
                          fontWeight: tokens.typography.fontWeight.medium,
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          fontFamily: tokens.typography.fontFamily.sans.join(', '),
                          width: '100%',
                          textAlign: 'center',
                          marginTop: tokens.spacing[3],
                        }}
                      >
                        {historyExpanded ? t('collapse') : `${t('expandAll')} (${sortedHistory.length})`}
                      </button>
                    )}
                  </Box>
                )}
              </Box>
            ) : (
              <EmptyState 
                message={t('noPositionHistory')} 
                subMessage={t('noPositionHistoryDesc')}
              />
            )
          )}
        </Box>
      </Box>

      {/* Market Detail Drawer */}
      {selectedMarket && (
        <>
          {/* Backdrop */}
          <Box
            style={{
              position: 'fixed',
              inset: 0,
              background: 'var(--color-overlay-dark)',
              zIndex: tokens.zIndex.overlay,
              opacity: 1,
              transition: 'opacity 0.3s ease',
            }}
            onClick={() => setSelectedMarket(null)}
          />
          {/* Drawer */}
          <Box
            style={{
              position: 'fixed',
              right: 0,
              top: 0,
              bottom: 0,
              width: 'min(420px, 90vw)',
              background: `linear-gradient(135deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary} 100%)`,
              borderLeft: `1px solid ${tokens.colors.border.primary}`,
              padding: tokens.spacing[6],
              zIndex: tokens.zIndex.modal,
              overflowY: 'auto',
              boxShadow: '-8px 0 32px var(--color-overlay-medium)',
              transform: 'translateX(0)',
              transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <CryptoIcon symbol={selectedMarket} size={48} />
                <Text size="xl" weight="black" style={{ color: tokens.colors.text.primary }}>
                  {selectedMarket}
                </Text>
              </Box>
              <button aria-label="Close"
                onClick={() => setSelectedMarket(null)}
                style={{
                  background: tokens.colors.bg.tertiary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  color: tokens.colors.text.secondary,
                  cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.xl,
                  width: 44,
                  height: 44,
                  borderRadius: tokens.radius.full,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s ease',
                }}
              >
                ×
              </button>
            </Box>
            <Text size="sm" color="secondary">
              {t('loadingDetails')}
            </Text>
          </Box>
        </>
      )}
    </>
  )
}

// 详细的仓位历史卡片组件
const PositionHistoryCard = memo(function PositionHistoryCard({ position, index }: { position: ExtendedPositionHistoryItem; index: number }) {
  const { t } = useLanguage()
  const [isHovered, setIsHovered] = useState(false)
  const isLong = position.direction === 'long'
  const isProfit = (position.pnlUsd ?? position.pnlPct ?? 0) >= 0
  const coinName = position.symbol.replace('USDT', '').replace('BUSD', '')

  return (
    <Box 
      className="position-card"
      style={{ 
        background: isHovered 
          ? `linear-gradient(135deg, ${tokens.colors.bg.primary}F0, ${tokens.colors.bg.secondary}E0)`
          : tokens.colors.bg.primary,
        border: `1px solid ${isHovered ? tokens.colors.accent.primary + '40' : tokens.colors.border.primary}`,
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[5],
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        transform: isHovered ? 'translateY(-4px) scale(1.01)' : 'translateY(0) scale(1)',
        boxShadow: isHovered ? `0 12px 32px var(--color-overlay-light)` : 'none',
        animationDelay: `${index * 0.05}s`,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Header */}
      <Box style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: tokens.spacing[2], 
        marginBottom: tokens.spacing[4],
        paddingBottom: tokens.spacing[3],
        borderBottom: `1px solid ${tokens.colors.border.primary}40`,
      }}>
        {/* 币种图标 */}
        <CryptoIcon symbol={coinName} size={32} />
        
        {/* 币种名称 */}
        <Text size="base" weight="black" style={{ color: tokens.colors.text.primary }}>
          {position.symbol}
        </Text>
        
        {/* 标签组 */}
        <Box style={{ display: 'flex', gap: tokens.spacing[1], marginLeft: 'auto' }}>
          <Box style={{ 
            padding: `2px 8px`, 
            borderRadius: tokens.radius.full,
            background: tokens.colors.bg.tertiary,
          }}>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
              {position.positionType === 'perpetual' ? t('perpetual') : t('delivery')}
            </Text>
          </Box>
          
          <Box style={{ 
            padding: `2px 10px`, 
            borderRadius: tokens.radius.full,
            background: isLong ? `${tokens.colors.accent.success}15` : `${tokens.colors.accent.error}15`,
            border: `1px solid ${isLong ? tokens.colors.accent.success : tokens.colors.accent.error}30`,
          }}>
            <Text size="xs" style={{ 
              color: isLong ? tokens.colors.accent.success : tokens.colors.accent.error,
              fontWeight: 600,
            }}>
              {position.marginMode === 'cross' ? t('crossMargin') : t('isolatedMargin')} {isLong ? t('long') : t('short')}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* 数据网格 */}
      <Box className="trading-grid" style={{
        display: 'grid',
        gap: tokens.spacing[4],
        marginBottom: tokens.spacing[3],
      }}>
        <DataCell label={t('openTime')} value={position.openTime ? formatDateTime(position.openTime) : '--'} />
        <DataCell label={t('openPrice')} value={`${formatPriceWithComma(position.entryPrice)}`} />
        <DataCell
          label={t('closePnl')}
          value={position.pnlUsd !== undefined && position.pnlUsd !== 0
            ? `${isProfit ? '+' : ''}${formatPriceWithComma(position.pnlUsd)} USDT`
            : `${isProfit ? '+' : ''}${(position.pnlPct ?? 0).toFixed(2)}%`
          }
          highlight
          isProfit={isProfit}
        />
      </Box>

      <Box className="trading-grid" style={{
        display: 'grid',
        gap: tokens.spacing[4],
      }}>
        <DataCell label={t('closePrice')} value={`${formatPriceWithComma(position.exitPrice)}`} secondary />
        <DataCell label={t('maxPosition')} value={formatSizeWithUnit(position.maxPositionSize, coinName)} secondary />
        <DataCell label={t('closeTime')} value={position.closeTime ? formatDateTime(position.closeTime) : '--'} secondary />
      </Box>
    </Box>
  )
})

// 数据单元格组件
const DataCell = memo(function DataCell({ 
  label, 
  value, 
  highlight, 
  isProfit,
  secondary 
}: { 
  label: string
  value: string
  highlight?: boolean
  isProfit?: boolean
  secondary?: boolean
}) {
  return (
    <Box>
      <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 4, display: 'block' }}>
        {label}
      </Text>
      <Text 
        size="sm" 
        weight={highlight ? 'black' : 'bold'}
        style={{ 
          color: highlight 
            ? (isProfit ? tokens.colors.accent.success : tokens.colors.accent.error)
            : (secondary ? tokens.colors.text.secondary : tokens.colors.text.primary),
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
        }}
      >
        {value}
      </Text>
    </Box>
  )
})

// 格式化函数
function formatPriceWithComma(price: number | undefined): string {
  if (price === undefined || price === 0) return '--'
  return price.toLocaleString('en-US', { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: price >= 1 ? 2 : 4 
  })
}

function formatSizeWithUnit(size: number | undefined, unit: string): string {
  if (size === undefined || size === 0) return '--'
  return `${size.toFixed(3)} ${unit}`
}

function formatPrice(price: number | undefined): string {
  if (price === undefined || price === 0) return '--'
  return price >= 1 ? price.toFixed(2) : price.toFixed(4)
}

function formatDateTime(timeStr: string): string {
  if (!timeStr) return '--'
  const date = new Date(timeStr)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const thStyle = {
  padding: tokens.spacing[4],
  fontSize: tokens.typography.fontSize.xs,
  color: tokens.colors.text.tertiary,
  fontWeight: tokens.typography.fontWeight.bold,
  borderBottom: `1px solid ${tokens.colors.border.primary}40`,
}

function EmptyState({ message, subMessage }: { message: string; subMessage: string }) {
  return (
    <Box style={{ 
      padding: tokens.spacing[10], 
      textAlign: 'center',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: tokens.spacing[3],
    }}>
      <Text size="base" color="secondary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
        {message}
      </Text>
      <Text size="sm" color="tertiary">
        {subMessage}
      </Text>
    </Box>
  )
}
