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

  if (!copyTradeUrl) return null

  const handleConfirm = () => {
    if (acknowledged) {
      window.open(copyTradeUrl, '_blank', 'noopener,noreferrer')
      setShowWarning(false)
      setAcknowledged(false)
    }
  }

  return (
    <>
      {/* 跟单按钮 */}
      <Button
        variant="primary"
        size="sm"
        onClick={() => setShowWarning(true)}
        style={{
          background: `linear-gradient(135deg, ${tokens.colors.accent.success} 0%, #00D4AA 100%)`,
          border: 'none',
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.lg,
          boxShadow: `0 4px 12px ${tokens.colors.accent.success}40`,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.transform = 'translateY(-2px)'
          e.currentTarget.style.boxShadow = `0 6px 20px ${tokens.colors.accent.success}50`
        }}
        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = `0 4px 12px ${tokens.colors.accent.success}40`
        }}
      >
        <ExternalLinkIcon size={14} />
        <span style={{ fontWeight: 700 }}>
          {language === 'zh' ? `去 ${exchangeName} 跟单` : `Copy on ${exchangeName}`}
        </span>
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
