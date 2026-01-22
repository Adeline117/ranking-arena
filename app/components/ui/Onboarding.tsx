'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { setLanguage } from '@/lib/i18n'

// ============================================
// 类型定义
// ============================================

type Language = 'zh' | 'en'
type Theme = 'dark' | 'light'

type OnboardingStep = {
  id: string
  title: { zh: string; en: string }
  subtitle?: { zh: string; en: string }
}

// ============================================
// 配置
// ============================================

const STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    title: { zh: '欢迎来到 Arena', en: 'Welcome to Arena' },
    subtitle: { zh: '加密交易员排行榜与社区', en: 'Crypto Trader Leaderboard & Community' },
  },
  {
    id: 'language',
    title: { zh: '选择语言', en: 'Select Language' },
    subtitle: { zh: '你可以随时在设置中更改', en: 'You can change this later in settings' },
  },
  {
    id: 'theme',
    title: { zh: '选择主题', en: 'Select Theme' },
    subtitle: { zh: '根据你的喜好选择', en: 'Choose based on your preference' },
  },
  {
    id: 'features',
    title: { zh: '主要功能', en: 'Key Features' },
    subtitle: { zh: '了解 Arena 可以做什么', en: 'Learn what Arena can do' },
  },
]

const FEATURES = {
  zh: [
    { icon: '📊', title: '交易员排行', desc: '实时追踪顶级交易员' },
    { icon: '👥', title: '社区讨论', desc: '与交易者交流心得' },
    { icon: '🔔', title: '智能提醒', desc: '关注交易员动态' },
    { icon: '📈', title: '数据分析', desc: '深度绩效分析' },
  ],
  en: [
    { icon: '📊', title: 'Leaderboard', desc: 'Track top traders in real-time' },
    { icon: '👥', title: 'Community', desc: 'Discuss with other traders' },
    { icon: '🔔', title: 'Alerts', desc: 'Follow trader activities' },
    { icon: '📈', title: 'Analytics', desc: 'Deep performance analysis' },
  ],
}

const TRANSLATIONS = {
  zh: {
    next: '下一步',
    back: '返回',
    skip: '跳过',
    start: '开始使用',
    chinese: '中文',
    english: 'English',
    dark: '深色模式',
    light: '浅色模式',
  },
  en: {
    next: 'Next',
    back: 'Back',
    skip: 'Skip',
    start: 'Get Started',
    chinese: '中文',
    english: 'English',
    dark: 'Dark Mode',
    light: 'Light Mode',
  },
}

// ============================================
// 进度指示器
// ============================================

function ProgressIndicator({ 
  current, 
  total, 
  onStepClick 
}: { 
  current: number
  total: number
  onStepClick?: (step: number) => void
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginBottom: 32,
    }}>
      {Array.from({ length: total }).map((_, i) => (
        <button
          key={i}
          onClick={() => onStepClick?.(i)}
          disabled={!onStepClick}
          style={{
            width: i === current ? 24 : 8,
            height: 8,
            borderRadius: 4,
            background: i === current 
              ? tokens.colors.accent.primary 
              : i < current 
                ? `${tokens.colors.accent.primary}60`
                : tokens.colors.border.primary,
            border: 'none',
            cursor: onStepClick ? 'pointer' : 'default',
            transition: 'all 0.3s ease',
          }}
        />
      ))}
    </div>
  )
}

// ============================================
// 选项卡片
// ============================================

function OptionCard({
  selected,
  onClick,
  children,
  isDark,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
  isDark: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '20px 16px',
        borderRadius: 16,
        border: `2px solid ${selected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
        background: selected
          ? `${tokens.colors.accent.primary}15`
          : isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.03)',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {children}
    </button>
  )
}

// ============================================
// 主组件
// ============================================

export function OnboardingFlow({
  onComplete,
  initialLanguage = 'zh',
  initialTheme = 'dark',
}: {
  onComplete: () => void
  initialLanguage?: Language
  initialTheme?: Theme
}) {
  const [currentStep, setCurrentStep] = useState(0)
  const [language, setLang] = useState<Language>(initialLanguage)
  const [theme, setTheme] = useState<Theme>(initialTheme)

  const t = TRANSLATIONS[language]
  const isDark = theme === 'dark'
  const step = STEPS[currentStep]

  const handleNext = useCallback(() => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(prev => prev + 1)
    } else {
      // 完成引导
      setLanguage(language)
      localStorage.setItem('theme', theme)
      localStorage.setItem('hasOnboarded', 'true')
      document.documentElement.setAttribute('data-theme', theme)
      onComplete()
    }
  }, [currentStep, language, theme, onComplete])

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1)
    }
  }, [currentStep])

  const handleSkip = useCallback(() => {
    // 使用默认设置完成引导
    setLanguage(language)
    localStorage.setItem('theme', theme)
    localStorage.setItem('hasOnboarded', 'true')
    document.documentElement.setAttribute('data-theme', theme)
    onComplete()
  }, [language, theme, onComplete])

  const handleLanguageChange = (lang: Language) => {
    setLang(lang)
  }

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  // 样式变量
  const textPrimary = isDark ? '#f2f2f2' : '#1a1a1a'
  const textSecondary = isDark ? '#8a8a8a' : '#666666'

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      maxWidth: 480,
    }}>
      {/* 进度指示器 */}
      <ProgressIndicator 
        current={currentStep} 
        total={STEPS.length} 
      />

      {/* 标题区域 */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <h1 style={{
          fontSize: 24,
          fontWeight: 800,
          color: textPrimary,
          marginBottom: 8,
        }}>
          {step.title[language]}
        </h1>
        {step.subtitle && (
          <p style={{
            fontSize: 14,
            color: textSecondary,
          }}>
            {step.subtitle[language]}
          </p>
        )}
      </div>

      {/* 步骤内容 */}
      <div style={{ minHeight: 200, marginBottom: 32 }}>
        {/* 欢迎页 */}
        {currentStep === 0 && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{
              fontSize: 72,
              marginBottom: 24,
              filter: 'drop-shadow(0 4px 12px rgba(139, 111, 168, 0.3))',
            }}>
              🏆
            </div>
            <p style={{
              fontSize: 16,
              color: textSecondary,
              lineHeight: 1.8,
              maxWidth: 320,
              margin: '0 auto',
            }}>
              {language === 'zh' 
                ? 'Arena 帮助你发现和追踪全球最优秀的加密交易员，提升你的交易策略。'
                : 'Arena helps you discover and track the best crypto traders worldwide to improve your trading strategy.'}
            </p>
          </div>
        )}

        {/* 语言选择 */}
        {currentStep === 1 && (
          <div style={{ display: 'flex', gap: 16 }}>
            <OptionCard
              selected={language === 'zh'}
              onClick={() => handleLanguageChange('zh')}
              isDark={isDark}
            >
              <span style={{ fontSize: 32 }}>🇨🇳</span>
              <span style={{ fontWeight: 700, color: textPrimary }}>{t.chinese}</span>
            </OptionCard>
            <OptionCard
              selected={language === 'en'}
              onClick={() => handleLanguageChange('en')}
              isDark={isDark}
            >
              <span style={{ fontSize: 32 }}>🇺🇸</span>
              <span style={{ fontWeight: 700, color: textPrimary }}>{t.english}</span>
            </OptionCard>
          </div>
        )}

        {/* 主题选择 */}
        {currentStep === 2 && (
          <div style={{ display: 'flex', gap: 16 }}>
            <OptionCard
              selected={theme === 'dark'}
              onClick={() => handleThemeChange('dark')}
              isDark={isDark}
            >
              <span style={{ fontSize: 32 }}>🌙</span>
              <span style={{ fontWeight: 700, color: textPrimary }}>{t.dark}</span>
            </OptionCard>
            <OptionCard
              selected={theme === 'light'}
              onClick={() => handleThemeChange('light')}
              isDark={isDark}
            >
              <span style={{ fontSize: 32 }}>☀️</span>
              <span style={{ fontWeight: 700, color: textPrimary }}>{t.light}</span>
            </OptionCard>
          </div>
        )}

        {/* 功能介绍 */}
        {currentStep === 3 && (
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(2, 1fr)', 
            gap: 12,
          }}>
            {FEATURES[language].map((feature, i) => (
              <div
                key={i}
                style={{
                  padding: 16,
                  borderRadius: 12,
                  background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.03)',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 28, marginBottom: 8 }}>{feature.icon}</div>
                <div style={{ fontWeight: 700, color: textPrimary, fontSize: 14, marginBottom: 4 }}>
                  {feature.title}
                </div>
                <div style={{ color: textSecondary, fontSize: 12 }}>
                  {feature.desc}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部按钮 */}
      <div style={{ display: 'flex', gap: 12 }}>
        {currentStep > 0 && (
          <button
            onClick={handleBack}
            style={{
              flex: 1,
              padding: '14px 24px',
              borderRadius: 12,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: textSecondary,
              fontWeight: 700,
              fontSize: 14,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            {t.back}
          </button>
        )}
        
        <button
          onClick={handleNext}
          style={{
            flex: currentStep === 0 ? 1 : 2,
            padding: '14px 24px',
            borderRadius: 12,
            border: 'none',
            background: `linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, #6B5B95 100%)`,
            color: '#fff',
            fontWeight: 800,
            fontSize: 14,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: `0 4px 16px ${tokens.colors.accent.primary}40`,
          }}
        >
          {currentStep === STEPS.length - 1 ? t.start : t.next}
        </button>
      </div>

      {/* 跳过按钮 */}
      <button
        onClick={handleSkip}
        style={{
          marginTop: 16,
          padding: '10px',
          background: 'transparent',
          border: 'none',
          color: textSecondary,
          fontSize: 13,
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        {t.skip}
      </button>
    </div>
  )
}

export default OnboardingFlow
