'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

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
function getCopyTradeUrl(source: string | undefined, traderId: string): string | null {
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
  }

  return urlMap[source.toLowerCase()] || null
}

/**
 * 获取交易所名称
 * v2.0: 仅保留 4 个核心交易所
 */
function getExchangeName(source: string | undefined): string {
  if (!source) return '交易所'

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
  }

  return nameMap[source.toLowerCase()] || source
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
  const { language } = useLanguage()
  const [showWarning, setShowWarning] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const copyTradeUrl = getCopyTradeUrl(source, traderId)
  const exchangeName = getExchangeName(source)

  // 如果不支持跟单，显示醒目的锁定按钮
  if (!copyTradeUrl) {
    return (
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
          borderRadius: tokens.radius.xl,
          background: `linear-gradient(135deg, rgba(156, 163, 175, 0.2) 0%, rgba(107, 114, 128, 0.15) 100%)`,
          border: `2px dashed rgba(156, 163, 175, 0.5)`,
          cursor: 'not-allowed',
          boxShadow: `0 2px 8px rgba(0, 0, 0, 0.1)`,
        }}
      >
        <Box
          style={{
            width: 28,
            height: 28,
            borderRadius: tokens.radius.full,
            background: 'rgba(156, 163, 175, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="rgba(107, 114, 128, 0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </Box>
        <Text size="sm" weight="bold" style={{ color: 'rgba(107, 114, 128, 0.9)', fontSize: 14 }}>
          {language === 'zh' ? '暂不支持跟单' : 'Copy trading unavailable'}
        </Text>
      </Box>
    )
  }

  const handleConfirm = () => {
    if (acknowledged) {
      window.open(copyTradeUrl, '_blank', 'noopener,noreferrer')
      setShowWarning(false)
      setAcknowledged(false)
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
          background: `linear-gradient(135deg, #00C853 0%, #00E676 50%, #69F0AE 100%)`,
          border: '2px solid rgba(255, 255, 255, 0.3)',
          padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
          borderRadius: tokens.radius.xl,
          boxShadow: `0 4px 20px rgba(0, 200, 83, 0.5), 0 0 40px rgba(0, 230, 118, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3)`,
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
          e.currentTarget.style.boxShadow = `0 8px 30px rgba(0, 200, 83, 0.6), 0 0 60px rgba(0, 230, 118, 0.4)`
        }}
        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.transform = 'translateY(0) scale(1)'
          e.currentTarget.style.boxShadow = `0 4px 20px rgba(0, 200, 83, 0.5), 0 0 40px rgba(0, 230, 118, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3)`
        }}
      >
        <style>{`
          @keyframes pulseGlow {
            0%, 100% { box-shadow: 0 4px 20px rgba(0, 200, 83, 0.5), 0 0 40px rgba(0, 230, 118, 0.3); }
            50% { box-shadow: 0 4px 25px rgba(0, 200, 83, 0.7), 0 0 50px rgba(0, 230, 118, 0.5); }
          }
        `}</style>
        <Box
          style={{
            width: 24,
            height: 24,
            borderRadius: tokens.radius.full,
            background: 'rgba(255, 255, 255, 0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ExternalLinkIcon size={14} />
        </Box>
        <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: '0.3px', textShadow: '0 1px 2px rgba(0,0,0,0.2)' }}>
          {language === 'zh' ? `去 ${exchangeName} 跟单` : `Copy on ${exchangeName}`}
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
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
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
              boxShadow: '0 24px 48px rgba(0, 0, 0, 0.3)',
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
                  {language === 'zh' ? '风险提示' : 'Risk Warning'}
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
                {language === 'zh' ? (
                  <>
                    您即将离开 Arena 前往 <strong>{exchangeName}</strong> 进行跟单操作
                    {traderHandle && <>（交易员：<strong>{traderHandle}</strong>）</>}。
                    <br /><br />
                    <strong style={{ color: tokens.colors.accent.warning }}>请注意以下风险：</strong>
                    <br />
                    • 跟单交易存在重大风险，可能导致<strong>全部本金损失</strong>
                    <br />
                    • 过往业绩不代表未来表现
                    <br />
                    • Arena 仅提供数据展示，<strong>不对跟单结果负责</strong>
                    <br />
                    • 请根据自身风险承受能力谨慎决策
                  </>
                ) : (
                  <>
                    You are about to leave Arena and go to <strong>{exchangeName}</strong> for copy trading
                    {traderHandle && <> (Trader: <strong>{traderHandle}</strong>)</>}.
                    <br /><br />
                    <strong style={{ color: tokens.colors.accent.warning }}>Please note the following risks:</strong>
                    <br />
                    • Copy trading involves significant risks and may result in <strong>total loss of principal</strong>
                    <br />
                    • Past performance does not guarantee future results
                    <br />
                    • Arena only provides data display and is <strong>not responsible for copy trading results</strong>
                    <br />
                    • Please make careful decisions based on your risk tolerance
                  </>
                )}
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
                  {language === 'zh'
                    ? '我已了解跟单风险，自愿前往交易所进行跟单操作'
                    : 'I understand the risks and voluntarily proceed to the exchange for copy trading'}
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
                {language === 'zh' ? '取消' : 'Cancel'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConfirm}
                disabled={!acknowledged}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: acknowledged
                    ? `linear-gradient(135deg, ${tokens.colors.accent.success} 0%, #00D4AA 100%)`
                    : tokens.colors.bg.tertiary,
                  border: 'none',
                  opacity: acknowledged ? 1 : 0.5,
                  cursor: acknowledged ? 'pointer' : 'not-allowed',
                }}
              >
                {language === 'zh' ? `前往 ${exchangeName}` : `Go to ${exchangeName}`}
              </Button>
            </Box>
          </Box>
        </Box>
      )}
    </>
  )
}
