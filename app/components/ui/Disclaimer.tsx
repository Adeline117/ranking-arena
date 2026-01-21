'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'

// ============================================
// 类型定义
// ============================================

interface DisclaimerProps {
  /** 是否需要确认复选框 */
  requireConfirmation?: boolean
  /** 确认后的回调 */
  onConfirm?: () => void
  /** 取消的回调 */
  onCancel?: () => void
  /** 展示模式 */
  variant?: 'inline' | 'modal' | 'banner'
  /** 免责声明类型 */
  type?: 'investment' | 'risk' | 'general'
  /** 自定义内容 */
  customContent?: string
  /** 是否可关闭 */
  dismissible?: boolean
  /** 本地存储 key（用于记住用户选择） */
  storageKey?: string
}

// ============================================
// 免责声明内容
// ============================================

const DISCLAIMER_CONTENT = {
  investment: {
    title: '投资风险提示',
    icon: '',
    content: `本平台提供的所有内容（包括但不限于排名、评价、组合建议）仅供参考，不构成任何投资建议或推荐。

加密货币交易具有极高风险，您可能损失全部投入资金。过往业绩不代表未来表现。

请根据自身财务状况和风险承受能力，独立做出投资决策。在进行任何交易前，请咨询专业的财务顾问。`,
    confirmText: '我已阅读并理解上述风险提示',
  },
  risk: {
    title: '风险警告',
    icon: '',
    content: `跟单交易存在显著风险：

• 交易员过往表现不能保证未来收益
• 交易员风格可能随时改变
• 交易所数据可能存在延迟或不准确
• 高收益往往伴随高风险

请谨慎评估风险，切勿投入超过您能承受损失的资金。`,
    confirmText: '我已了解并接受相关风险',
  },
  general: {
    title: '免责声明',
    icon: '',
    content: `本平台汇集来自多个交易所的公开数据。我们不对数据的准确性、完整性或时效性做任何保证。

用户生成的内容（评价、日记等）代表发布者个人观点，不代表本平台立场。

使用本平台即表示您同意我们的服务条款和隐私政策。`,
    confirmText: '我已阅读并同意',
  },
}

// ============================================
// 投资免责声明组件
// ============================================

export function InvestmentDisclaimer({
  requireConfirmation = true,
  onConfirm,
  onCancel,
  variant = 'inline',
  type = 'investment',
  customContent,
  dismissible = false,
  storageKey,
}: DisclaimerProps) {
  const [confirmed, setConfirmed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  
  const disclaimerData = DISCLAIMER_CONTENT[type]
  const content = customContent || disclaimerData.content

  // 检查本地存储
  useEffect(() => {
    if (storageKey) {
      const stored = localStorage.getItem(`disclaimer_${storageKey}`)
      if (stored === 'confirmed') {
        setDismissed(true)
        onConfirm?.()
      }
    }
  }, [storageKey, onConfirm])

  const handleConfirm = () => {
    if (!requireConfirmation || confirmed) {
      if (storageKey) {
        localStorage.setItem(`disclaimer_${storageKey}`, 'confirmed')
      }
      setDismissed(true)
      onConfirm?.()
    }
  }

  const handleDismiss = () => {
    if (dismissible) {
      setDismissed(true)
    }
  }

  if (dismissed) {
    return null
  }

  // ============================================
  // 模态框模式
  // ============================================
  if (variant === 'modal') {
    return (
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: tokens.spacing[4],
          zIndex: tokens.zIndex.modal,
        }}
      >
        <Box
          style={{
            maxWidth: 500,
            width: '100%',
            background: tokens.colors.bg.primary,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <Box
            style={{
              padding: tokens.spacing[4],
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
              background: `${tokens.colors.accent.warning}10`,
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
            }}
          >
            <Text size="2xl">{disclaimerData.icon}</Text>
            <Text size="lg" weight="bold">
              {disclaimerData.title}
            </Text>
          </Box>

          {/* Content */}
          <Box style={{ padding: tokens.spacing[5] }}>
            <Text
              size="sm"
              style={{
                whiteSpace: 'pre-line',
                lineHeight: 1.7,
                color: tokens.colors.text.secondary,
              }}
            >
              {content}
            </Text>

            {/* Confirmation checkbox */}
            {requireConfirmation && (
              <Box
                style={{
                  marginTop: tokens.spacing[5],
                  padding: tokens.spacing[4],
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.lg,
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: tokens.spacing[3],
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    style={{
                      marginTop: 2,
                      width: 18,
                      height: 18,
                      accentColor: tokens.colors.accent.primary,
                    }}
                  />
                  <Text size="sm" weight="medium">
                    {disclaimerData.confirmText}
                  </Text>
                </label>
              </Box>
            )}
          </Box>

          {/* Actions */}
          <Box
            style={{
              padding: tokens.spacing[4],
              borderTop: `1px solid ${tokens.colors.border.primary}`,
              display: 'flex',
              gap: tokens.spacing[3],
              justifyContent: 'flex-end',
            }}
          >
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                取消
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleConfirm}
              disabled={requireConfirmation && !confirmed}
            >
              确认
            </Button>
          </Box>
        </Box>
      </Box>
    )
  }

  // ============================================
  // 横幅模式
  // ============================================
  if (variant === 'banner') {
    return (
      <Box
        style={{
          padding: tokens.spacing[4],
          background: `${tokens.colors.accent.warning}15`,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.accent.warning}40`,
          marginBottom: tokens.spacing[4],
        }}
      >
        <Box
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: tokens.spacing[3],
          }}
        >
          <Text size="lg">{disclaimerData.icon}</Text>
          <Box style={{ flex: 1 }}>
            <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[1] }}>
              {disclaimerData.title}
            </Text>
            <Text size="xs" color="secondary" style={{ lineHeight: 1.5 }}>
              {content.split('\n')[0]}
            </Text>
          </Box>
          {dismissible && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              style={{ padding: tokens.spacing[1] }}
            >
              ✕
            </Button>
          )}
        </Box>
      </Box>
    )
  }

  // ============================================
  // 内联模式（默认）
  // ============================================
  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[3],
        }}
      >
        <Text size="lg">{disclaimerData.icon}</Text>
        <Text size="sm" weight="semibold">
          {disclaimerData.title}
        </Text>
      </Box>

      <Text
        size="xs"
        color="tertiary"
        style={{
          whiteSpace: 'pre-line',
          lineHeight: 1.6,
        }}
      >
        {content}
      </Text>

      {requireConfirmation && (
        <Box style={{ marginTop: tokens.spacing[4] }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{
                width: 16,
                height: 16,
                accentColor: tokens.colors.accent.primary,
              }}
            />
            <Text size="xs">{disclaimerData.confirmText}</Text>
          </label>
        </Box>
      )}
    </Box>
  )
}

// ============================================
// 简化版风险提示（用于卡片底部等）
// ============================================

export function RiskWarningBadge({ 
  size = 'sm' 
}: { 
  size?: 'xs' | 'sm' 
}) {
  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacing[1],
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        background: `${tokens.colors.accent.warning}15`,
        borderRadius: tokens.radius.md,
      }}
    >
      <Text size={size} style={{ color: tokens.colors.accent.warning }}>
        [风险提示] 投资有风险
      </Text>
    </Box>
  )
}

// ============================================
// 首次使用引导免责声明
// ============================================

export function FirstTimeDisclaimer({
  onAccept,
}: {
  onAccept: () => void
}) {
  const [step, setStep] = useState(0)
  const [accepted, setAccepted] = useState<boolean[]>([false, false])

  const steps = [
    DISCLAIMER_CONTENT.investment,
    DISCLAIMER_CONTENT.risk,
  ]

  const handleAccept = (index: number) => {
    const newAccepted = [...accepted]
    newAccepted[index] = true
    setAccepted(newAccepted)
  }

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1)
    } else {
      localStorage.setItem('arena_disclaimer_accepted', 'true')
      onAccept()
    }
  }

  const currentStep = steps[step]
  const canProceed = accepted[step]

  return (
    <Box
      style={{
        position: 'fixed',
        inset: 0,
        background: tokens.colors.bg.primary,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacing[6],
        zIndex: tokens.zIndex.overlay, // 使用 design tokens (300)
      }}
    >
      <Box style={{ maxWidth: 480, width: '100%' }}>
        {/* Progress */}
        <Box
          style={{
            display: 'flex',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[6],
          }}
        >
          {steps.map((_, i) => (
            <Box
              key={i}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                background:
                  i <= step
                    ? tokens.colors.accent.primary
                    : tokens.colors.bg.tertiary,
                transition: 'background 0.3s ease',
              }}
            />
          ))}
        </Box>

        {/* Icon */}
        <Text
          style={{
            fontSize: 64,
            textAlign: 'center',
            marginBottom: tokens.spacing[4],
          }}
        >
          {currentStep.icon}
        </Text>

        {/* Title */}
        <Text
          size="2xl"
          weight="bold"
          style={{ textAlign: 'center', marginBottom: tokens.spacing[4] }}
        >
          {currentStep.title}
        </Text>

        {/* Content */}
        <Box
          style={{
            padding: tokens.spacing[5],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.xl,
            marginBottom: tokens.spacing[5],
          }}
        >
          <Text
            size="sm"
            color="secondary"
            style={{
              whiteSpace: 'pre-line',
              lineHeight: 1.7,
            }}
          >
            {currentStep.content}
          </Text>
        </Box>

        {/* Checkbox */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            cursor: 'pointer',
            marginBottom: tokens.spacing[5],
          }}
        >
          <input
            type="checkbox"
            checked={accepted[step]}
            onChange={() => handleAccept(step)}
            style={{
              width: 20,
              height: 20,
              accentColor: tokens.colors.accent.primary,
            }}
          />
          <Text size="sm" weight="medium">
            {currentStep.confirmText}
          </Text>
        </label>

        {/* Button */}
        <Button
          variant="primary"
          onClick={handleNext}
          disabled={!canProceed}
          style={{ width: '100%' }}
        >
          {step < steps.length - 1 ? '下一步' : '开始使用'}
        </Button>
      </Box>
    </Box>
  )
}

export default InvestmentDisclaimer
