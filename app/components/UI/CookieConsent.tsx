'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import {
  getConsentManager,
  hasConsented,
  acceptAllConsent,
  acceptNecessaryOnlyConsent,
  setConsent,
  type ConsentState,
  type ConsentCategory,
} from '@/lib/compliance/consent'

// ============================================
// Cookie 类别信息
// ============================================

interface CookieCategoryInfo {
  id: ConsentCategory
  name: string
  description: string
  required: boolean
}

const COOKIE_CATEGORIES: CookieCategoryInfo[] = [
  {
    id: 'necessary',
    name: '必要 Cookie',
    description: '这些 Cookie 是网站正常运行所必需的，无法关闭。它们用于保存您的登录状态和安全设置。',
    required: true,
  },
  {
    id: 'analytics',
    name: '分析 Cookie',
    description: '帮助我们了解用户如何使用网站，以便改进用户体验。这些数据是匿名收集的。',
    required: false,
  },
  {
    id: 'preferences',
    name: '偏好设置 Cookie',
    description: '记住您的偏好设置，如语言、主题等，为您提供个性化体验。',
    required: false,
  },
  {
    id: 'marketing',
    name: '营销 Cookie',
    description: '用于向您展示相关广告和内容推荐。禁用后仍会显示广告，但可能与您不太相关。',
    required: false,
  },
]

// ============================================
// 样式
// ============================================

const styles = {
  overlay: {
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    padding: '16px',
    background: 'rgba(0, 0, 0, 0.8)',
    backdropFilter: 'blur(10px)',
  },
  container: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '20px 24px',
    background: tokens.colors.bg.secondary,
    borderRadius: '12px',
    border: `1px solid ${tokens.colors.border.primary}`,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '16px',
    gap: '16px',
  },
  title: {
    fontSize: '18px',
    fontWeight: 600,
    color: tokens.colors.text.primary,
    margin: 0,
  },
  description: {
    fontSize: '14px',
    color: tokens.colors.text.secondary,
    lineHeight: 1.6,
    margin: '8px 0 0 0',
  },
  buttonGroup: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  button: {
    padding: '10px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    border: 'none',
  },
  primaryButton: {
    background: tokens.colors.accent.brand,
    color: '#FFFFFF',
  },
  secondaryButton: {
    background: 'transparent',
    color: tokens.colors.text.secondary,
    border: `1px solid ${tokens.colors.border.secondary}`,
  },
  linkButton: {
    background: 'transparent',
    color: tokens.colors.text.tertiary,
    padding: '10px 12px',
    textDecoration: 'underline',
  },
  // 详细设置样式
  settingsContainer: {
    marginTop: '16px',
    paddingTop: '16px',
    borderTop: `1px solid ${tokens.colors.border.primary}`,
  },
  categoryItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '12px 0',
    borderBottom: `1px solid ${tokens.colors.border.primary}`,
  },
  categoryInfo: {
    flex: 1,
    paddingRight: '16px',
  },
  categoryName: {
    fontSize: '14px',
    fontWeight: 500,
    color: tokens.colors.text.primary,
    marginBottom: '4px',
  },
  categoryDescription: {
    fontSize: '12px',
    color: tokens.colors.text.tertiary,
    lineHeight: 1.5,
  },
  toggle: {
    position: 'relative' as const,
    width: '44px',
    height: '24px',
    background: tokens.colors.bg.tertiary,
    borderRadius: '12px',
    cursor: 'pointer',
    transition: 'background 0.2s ease',
    flexShrink: 0,
  },
  toggleActive: {
    background: tokens.colors.accent.brand,
  },
  toggleDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  toggleKnob: {
    position: 'absolute' as const,
    top: '2px',
    left: '2px',
    width: '20px',
    height: '20px',
    background: '#FFFFFF',
    borderRadius: '50%',
    transition: 'transform 0.2s ease',
  },
  toggleKnobActive: {
    transform: 'translateX(20px)',
  },
}

// ============================================
// Toggle 组件
// ============================================

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
}) {
  return (
    <div
      style={{
        ...styles.toggle,
        ...(checked ? styles.toggleActive : {}),
        ...(disabled ? styles.toggleDisabled : {}),
      }}
      onClick={() => !disabled && onChange?.(!checked)}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          !disabled && onChange?.(!checked)
        }
      }}
    >
      <div
        style={{
          ...styles.toggleKnob,
          ...(checked ? styles.toggleKnobActive : {}),
        }}
      />
    </div>
  )
}

// ============================================
// Cookie Consent 组件
// ============================================

export function CookieConsent() {
  const [visible, setVisible] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [preferences, setPreferences] = useState<Partial<ConsentState>>({
    analytics: false,
    preferences: false,
    marketing: false,
  })

  useEffect(() => {
    // 检查是否已同意
    const consented = hasConsented()
    setVisible(!consented)
    
    // 如果已同意，加载当前偏好
    if (consented) {
      const state = getConsentManager().getState()
      setPreferences({
        analytics: state.analytics,
        preferences: state.preferences,
        marketing: state.marketing,
      })
    }
  }, [])

  const handleAcceptAll = () => {
    acceptAllConsent()
    setVisible(false)
  }

  const handleAcceptNecessary = () => {
    acceptNecessaryOnlyConsent()
    setVisible(false)
  }

  const handleSavePreferences = () => {
    setConsent({
      analytics: preferences.analytics || false,
      preferences: preferences.preferences || false,
      marketing: preferences.marketing || false,
    })
    setVisible(false)
  }

  const handleToggleCategory = (category: ConsentCategory) => {
    if (category === 'necessary') return // 必要 Cookie 不可切换
    
    setPreferences(prev => ({
      ...prev,
      [category]: !prev[category],
    }))
  }

  if (!visible) return null

  return (
    <div style={styles.overlay}>
      <div style={styles.container}>
        <div style={styles.header}>
          <div>
            <h3 style={styles.title}>🍪 Cookie 设置</h3>
            <p style={styles.description}>
              我们使用 Cookie 来改善您的浏览体验、分析网站流量并提供个性化内容。
              您可以选择接受所有 Cookie，或自定义您的偏好设置。
            </p>
          </div>
          
          {!showSettings && (
            <div style={styles.buttonGroup}>
              <button
                style={{ ...styles.button, ...styles.primaryButton }}
                onClick={handleAcceptAll}
              >
                接受全部
              </button>
              <button
                style={{ ...styles.button, ...styles.secondaryButton }}
                onClick={handleAcceptNecessary}
              >
                仅必要
              </button>
              <button
                style={{ ...styles.button, ...styles.linkButton }}
                onClick={() => setShowSettings(true)}
              >
                自定义设置
              </button>
            </div>
          )}
        </div>

        {showSettings && (
          <div style={styles.settingsContainer}>
            {COOKIE_CATEGORIES.map((category) => (
              <div key={category.id} style={styles.categoryItem}>
                <div style={styles.categoryInfo}>
                  <div style={styles.categoryName}>{category.name}</div>
                  <div style={styles.categoryDescription}>{category.description}</div>
                </div>
                <Toggle
                  checked={category.required || preferences[category.id] || false}
                  disabled={category.required}
                  onChange={() => handleToggleCategory(category.id)}
                />
              </div>
            ))}
            
            <div style={{ ...styles.buttonGroup, marginTop: '16px' }}>
              <button
                style={{ ...styles.button, ...styles.primaryButton }}
                onClick={handleSavePreferences}
              >
                保存设置
              </button>
              <button
                style={{ ...styles.button, ...styles.secondaryButton }}
                onClick={handleAcceptAll}
              >
                接受全部
              </button>
              <button
                style={{ ...styles.button, ...styles.linkButton }}
                onClick={() => setShowSettings(false)}
              >
                返回
              </button>
            </div>
          </div>
        )}
        
        <div style={{ marginTop: '12px', fontSize: '12px', color: tokens.colors.text.tertiary }}>
          了解更多请查看我们的{' '}
          <a href="/privacy" style={{ color: tokens.colors.accent.brand }}>隐私政策</a>
          {' '}和{' '}
          <a href="/terms" style={{ color: tokens.colors.accent.brand }}>使用条款</a>
        </div>
      </div>
    </div>
  )
}

export default CookieConsent
