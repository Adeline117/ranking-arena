'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { getCopyTradeUrl, getDexUrl } from '@/lib/utils/copy-trade'

// 外部链接图标
const ExternalLinkIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

// 警告图标
const WarningIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
)

// 关闭图标
const CloseIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)

/**
 * 根据交易所来源生成跟单链接
 * v2.0: 仅保留 4 个核心交易所
 */
function getCopyTradeUrl(source: string | undefined, traderId: string, traderHandle?: string): string | null {
  if (!source) return null

  const urlMap: Record<string, string> = {
    // Binance
    binance_futures: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}?type=um`,
    binance_spot: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}`,
    binance_web3: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}`,
    binance: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}`,
    // Bybit
    bybit: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${traderId}`,
    // Bitget
    bitget_futures: `https://www.bitget.com/zh-CN/copy-trading/trader?id=${traderId}`,
    bitget_spot: `https://www.bitget.com/zh-CN/copy-trading/trader?id=${traderId}`,
    bitget: `https://www.bitget.com/zh-CN/copy-trading/trader?id=${traderId}`,
    // OKX
    okx: `https://www.okx.com/copy-trading/trader/${traderId}`,
    // HTX
    htx: `https://futures.htx.com/en-us/copytrading/futures/detail/${traderId}`,
    htx_futures: `https://futures.htx.com/en-us/copytrading/futures/detail/${traderId}`,
    // Weex
    weex: `https://www.weex.com/zh-CN/copy-trading/trader/${traderId}`,
    // eToro — uses handle (UserName) not numeric ID
    etoro: `https://www.etoro.com/people/${traderHandle || traderId}/portfolio`,
  }

  return urlMap[source.toLowerCase()] || null
}

/** DEX platforms: link to trading page or trader profile (not copy-trade) */
function getDexUrl(source: string | undefined, traderId: string): string | null {
  if (!source) return null

  const urlMap: Record<string, string> = {
    hyperliquid: `https://app.hyperliquid.xyz/explorer/address/${traderId}`,
    dydx: `https://trade.dydx.exchange/portfolio/${traderId}`,
    gmx: `https://app.gmx.io/#/actions/v2/${traderId}`,
    jupiter_perps: `https://www.jup.ag/perps/${traderId}`,
    drift: `https://app.drift.trade/overview?userAccount=${traderId}`,
    aevo: `https://app.aevo.xyz/portfolio/${traderId}`,
    gains: `https://gains.trade`,
    vertex: `https://app.vertexprotocol.com/portfolio/${traderId}`,
  }

  return urlMap[source.toLowerCase()] || null
}

function getDexPlatformName(source: string | undefined): string | null {
  if (!source) return null
  const nameMap: Record<string, string> = {
    hyperliquid: 'Hyperliquid',
    dydx: 'dYdX',
    gmx: 'GMX',
    jupiter_perps: 'Jupiter Perps',
    drift: 'Drift',
    aevo: 'Aevo',
    gains: 'Gains Network',
    vertex: 'Vertex',
  }
  return nameMap[source.toLowerCase()] || null
}

/**
 * 获取交易所名称
 * v2.0: 仅保留 4 个核心交易所
 */
function getExchangeName(source: string | undefined): string {
  if (!source) return 'Exchange'

  const nameMap: Record<string, string> = {
    // Binance
    binance_futures: 'Binance',
    binance_spot: 'Binance',
    binance_web3: 'Binance',
    binance: 'Binance',
    // Bybit
    bybit: 'Bybit',
    // Bitget
    bitget_futures: 'Bitget',
    bitget_spot: 'Bitget',
    bitget: 'Bitget',
    // OKX
    okx: 'OKX',
    // HTX
    htx: 'HTX',
    htx_futures: 'HTX',
    // Weex
    weex: 'Weex',
    // eToro
    etoro: 'eToro',
  }

  return nameMap[source.toLowerCase()] || getDexPlatformName(source) || source
}

interface CopyTradeButtonProps {
  traderId: string
  source?: string
  traderHandle?: string
}

/**
 * 跟单按钮组件
 * 点击后显示风险提示弹窗，确认后跳转到交易所
 */
export default function CopyTradeButton({
  traderId,
  source,
  traderHandle,
}: CopyTradeButtonProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [showWarning, setShowWarning] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const copyTradeUrl = getCopyTradeUrl(source, traderId, traderHandle)
  const dexUrl = getDexUrl(source, traderId)
  const dexName = getDexPlatformName(source)
  const exchangeName = getExchangeName(source)

  // DEX: show "View on [Platform]" link instead of copy-trade
  if (!copyTradeUrl && dexUrl && dexName) {
    return (
      <a
        href={dexUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
          borderRadius: tokens.radius.xl,
          background: `linear-gradient(135deg, ${tokens.colors.accent.brand}15, ${tokens.colors.accent.brand}08)`,
          border: `1px solid ${tokens.colors.accent.brand}30`,
          cursor: 'pointer',
          textDecoration: 'none',
          transition: 'all 0.2s',
        }}
      >
        <ExternalLinkIcon size={14} />
        <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.brand, fontSize: 14 }}>
          {t('dexViewOn').replace('{platform}', dexName)}
        </Text>
      </a>
    )
  }

  // No CEX copy-trade and no DEX link — show small subtle text
  if (!copyTradeUrl) {
    return (
      <Text size="xs" style={{ color: 'var(--color-text-tertiary)', opacity: 0.6, fontSize: 11, whiteSpace: 'nowrap' }}>
          {t('copyTradeUnavailable')}
        </Text>
    )
  }

  const handleConfirm = () => {
    if (acknowledged && copyTradeUrl) {
      try {
        const newWindow = window.open(copyTradeUrl, '_blank', 'noopener,noreferrer')
        if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
          // Popup was blocked
          showToast(t('popupBlocked') || 'Popup blocked. Please allow popups for this site.', 'warning')
          return
        }
        setShowWarning(false)
        setAcknowledged(false)
      } catch {
        showToast(t('openLinkFailed') || 'Failed to open link', 'error')
      }
    }
  }

  return (
    <>
      {/* 跟单按钮 - 醒目设计 */}
      <Button
        variant="primary"
        size="sm"
        onClick={() => setShowWarning(true)}
        style={{
          background: `linear-gradient(135deg, ${tokens.colors.accent.success} 0%, ${tokens.colors.accent.success} 50%, ${tokens.colors.accent.success} 100%)`,
          border: '2px solid var(--glass-border-heavy)',
          padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
          borderRadius: tokens.radius.xl,
          boxShadow: `0 4px 20px var(--color-accent-success-20), 0 0 40px var(--color-accent-success-20), inset 0 1px 0 var(--glass-border-heavy)`,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          animation: 'pulseGlow 2s ease-in-out infinite',
          position: 'relative',
          overflow: 'hidden',
        }}
        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.transform = 'translateY(-3px) scale(1.02)'
          e.currentTarget.style.boxShadow = `0 8px 30px var(--color-accent-success), 0 0 60px var(--color-accent-success-20)`
        }}
        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.transform = 'translateY(0) scale(1)'
          e.currentTarget.style.boxShadow = `0 4px 20px var(--color-accent-success-20), 0 0 40px var(--color-accent-success-20), inset 0 1px 0 var(--glass-border-heavy)`
        }}
      >
        <style>{`
          @keyframes pulseGlow {
            0%, 100% { box-shadow: 0 4px 20px var(--color-accent-success-20), 0 0 40px var(--color-accent-success-20); }
            50% { box-shadow: 0 4px 25px var(--color-accent-success), 0 0 50px var(--color-accent-success-20); }
          }
        `}</style>
        <Box
          style={{
            width: 24,
            height: 24,
            borderRadius: tokens.radius.full,
            background: 'var(--glass-bg-heavy)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ExternalLinkIcon size={14} />
        </Box>
        <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: '0.3px', textShadow: 'var(--text-shadow-sm)' }}>
          {t('copyTradeOn').replace('{exchange}', exchangeName)}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </Button>

      {/* 风险提示弹窗 */}
      {showWarning && (
        <Box
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--color-backdrop)',
            backdropFilter: tokens.glass.blur.xs,
            WebkitBackdropFilter: tokens.glass.blur.xs,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: tokens.zIndex.max,
            padding: tokens.spacing[4],
          }}
          onClick={() => setShowWarning(false)}
        >
          <Box
            style={{
              background: tokens.colors.bg.primary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
              maxWidth: 420,
              width: '100%',
              boxShadow: '0 24px 48px var(--color-overlay-medium)',
              overflow: 'hidden',
            }}
            onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}
          >
            {/* 头部 */}
            <Box
              style={{
                padding: tokens.spacing[4],
                background: `${tokens.colors.accent.warning}15`,
                borderBottom: `1px solid ${tokens.colors.accent.warning}30`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <Box style={{ color: tokens.colors.accent.warning }}>
                  <WarningIcon size={24} />
                </Box>
                <Text size="md" weight="bold" style={{ color: tokens.colors.accent.warning }}>
                  {t('riskWarning')}
                </Text>
              </Box>
              <button
                onClick={() => setShowWarning(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: tokens.colors.text.tertiary,
                  padding: 4,
                  display: 'flex',
                }}
              >
                <CloseIcon size={20} />
              </button>
            </Box>

            {/* 内容 */}
            <Box style={{ padding: tokens.spacing[5] }}>
              <Text size="sm" color="secondary" style={{ lineHeight: 1.7, marginBottom: tokens.spacing[4] }}>
                {t('riskWarningLeaving').replace('{exchange}', exchangeName)}
                {traderHandle && <> ({t('trader')}: <strong>{traderHandle}</strong>)</>}
                <br /><br />
                <strong style={{ color: tokens.colors.accent.warning }}>{t('riskWarningNote')}</strong>
                <br />
                {t('riskWarningLoss')}
                <br />
                {t('riskWarningPast')}
                <br />
                {t('riskWarningArena')}
                <br />
                {t('riskWarningDecision')}
              </Text>

              {/* 确认勾选 */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: tokens.spacing[3],
                  cursor: 'pointer',
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${acknowledged ? tokens.colors.accent.success : tokens.colors.border.primary}`,
                  transition: 'all 0.2s',
                }}
              >
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  style={{
                    width: 18,
                    height: 18,
                    marginTop: 2,
                    accentColor: tokens.colors.accent.success,
                    cursor: 'pointer',
                  }}
                />
                <Text size="sm" color="primary" style={{ lineHeight: 1.5 }}>
                  {t('riskWarningAcknowledge')}
                </Text>
              </label>
            </Box>

            {/* 底部按钮 */}
            <Box
              style={{
                padding: tokens.spacing[4],
                borderTop: `1px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                gap: tokens.spacing[3],
                justifyContent: 'flex-end',
              }}
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowWarning(false)}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConfirm}
                disabled={!acknowledged}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: acknowledged
                    ? `linear-gradient(135deg, ${tokens.colors.accent.success} 0%, ${tokens.colors.accent.success} 100%)`
                    : tokens.colors.bg.tertiary,
                  border: 'none',
                  opacity: acknowledged ? 1 : 0.5,
                  cursor: acknowledged ? 'pointer' : 'not-allowed',
                }}
              >
                {t('copyTradeGoTo').replace('{exchange}', exchangeName)}
              </Button>
            </Box>
          </Box>
        </Box>
      )}
    </>
  )
}
