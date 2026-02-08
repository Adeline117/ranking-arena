'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Box, Text } from '@/app/components/base'
import { setLanguage, translations, type Language } from '@/lib/i18n'

type Theme = 'dark' | 'light'

// CSS 注入
const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('onboarding-styles')) return
  
  const style = document.createElement('style')
  style.id = 'onboarding-styles'
  style.textContent = `
    @keyframes onboardingGradient {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }
    
    .onboarding-bg {
      position: fixed;
      inset: 0;
      z-index: 0;
      transition: background 0.5s ease;
    }
    
    .onboarding-bg.dark {
      background: linear-gradient(135deg, #0a0a0f 0%, #13111a 50%, #0f0d14 100%);
    }
    
    .onboarding-bg.light {
      background: linear-gradient(135deg, #f5f5f7 0%, #e8e8ed 50%, #f0f0f5 100%);
    }
    
    .onboarding-bg::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at center, rgba(139, 111, 168, 0.08) 0%, transparent 50%);
      animation: onboardingGradient 20s ease infinite;
    }
    
    .onboarding-card {
      animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    
    .option-card {
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .option-card:hover {
      transform: translateY(-2px);
    }
    
    .option-card.selected {
      animation: pulse 2s ease infinite;
    }
    
    .continue-btn {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .continue-btn:not(:disabled):hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(139, 111, 168, 0.4);
    }
    
    .continue-btn:not(:disabled):active {
      transform: translateY(0) scale(0.98);
    }
    
    .floating-particle {
      position: absolute;
      border-radius: 50%;
      animation: float 6s ease-in-out infinite;
    }
    
    @keyframes float {
      0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.3; }
      50% { transform: translateY(-15px) rotate(180deg); opacity: 0.5; }
    }
  `
  document.head.appendChild(style)
}

export default function OnboardingPage() {
  const router = useRouter()
  const [language, setLang] = useState<Language>('zh')
  const [theme, setTheme] = useState<Theme>('dark')
  const [mounted, setMounted] = useState(false)

  const tr = (key: string) => translations[language][key] || translations.zh[key] || key

  useEffect(() => {
    injectStyles()
    setMounted(true)

    // 检查是否已经完成过设置
    const hasOnboarded = localStorage.getItem('hasOnboarded')
    if (hasOnboarded === 'true') {
      router.push('/login')
      return
    }

    // 获取已保存的设置
    const savedLang = localStorage.getItem('language') as Language | null
    const savedTheme = localStorage.getItem('theme') as Theme | null
    
    if (savedLang) setLang(savedLang)
    if (savedTheme) {
      setTheme(savedTheme)
      document.documentElement.setAttribute('data-theme', savedTheme)
    }
  }, [router])

  const handleLanguageChange = (lang: Language) => {
    setLang(lang)
    setLanguage(lang)
  }

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  const handleContinue = () => {
    // 保存设置
    setLanguage(language)
    localStorage.setItem('theme', theme)
    localStorage.setItem('hasOnboarded', 'true')
    document.documentElement.setAttribute('data-theme', theme)
    
    // 跳转到登录页
    router.push('/login')
  }

  if (!mounted) {
    return (
      <Box style={{ 
        minHeight: '100vh', 
        background: '#0a0a0f',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          width: 40,
          height: 40,
          border: '3px solid rgba(139, 111, 168, 0.2)',
          borderTopColor: 'var(--color-brand)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </Box>
    )
  }

  const isDark = theme === 'dark'
  const cardBg = isDark ? 'rgba(15, 15, 20, 0.85)' : 'rgba(255, 255, 255, 0.9)'
  const cardBorder = isDark ? 'rgba(139, 111, 168, 0.15)' : 'rgba(139, 111, 168, 0.2)'
  const textPrimary = isDark ? '#f2f2f2' : '#1a1a1a'
  const textSecondary = isDark ? '#8a8a8a' : '#666666'
  const optionBg = isDark ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.05)'
  const optionBorder = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
  const selectedBg = isDark 
    ? 'linear-gradient(135deg, rgba(139, 111, 168, 0.3) 0%, rgba(139, 111, 168, 0.15) 100%)'
    : 'linear-gradient(135deg, rgba(139, 111, 168, 0.2) 0%, rgba(139, 111, 168, 0.1) 100%)'
  const selectedBorder = 'rgba(139, 111, 168, 0.5)'

  return (
    <Box style={{ 
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* 动态背景 */}
      <div className={`onboarding-bg ${theme}`} />
      
      {/* 浮动粒子 */}
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="floating-particle"
          style={{
            width: 6 + i * 3,
            height: 6 + i * 3,
            left: `${15 + i * 18}%`,
            top: `${25 + (i % 3) * 20}%`,
            background: `linear-gradient(135deg, rgba(139, 111, 168, ${isDark ? 0.3 : 0.2}), rgba(139, 111, 168, 0.1))`,
            animationDelay: `${i * 0.7}s`,
            animationDuration: `${5 + i}s`,
          }}
        />
      ))}

      <Box 
        className="onboarding-card"
        style={{ 
          maxWidth: 480, 
          width: '100%',
          background: cardBg,
          border: `1px solid ${cardBorder}`,
          borderRadius: 28,
          padding: '48px 40px',
          position: 'relative',
          zIndex: 1,
          boxShadow: isDark 
            ? '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 100px rgba(139, 111, 168, 0.06)'
            : '0 25px 50px -12px rgba(0, 0, 0, 0.1), 0 0 100px rgba(139, 111, 168, 0.1)',
        }}
      >
        {/* Logo 和标题 */}
        <Box style={{ textAlign: 'center', marginBottom: 40 }}>
          <Text 
            size="3xl" 
            weight="black" 
            style={{ 
              marginBottom: 8,
              background: 'linear-gradient(135deg, var(--color-brand) 0%, #c9b8db 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Arena
          </Text>
          <Text 
            size="xl" 
            weight="bold" 
            style={{ 
              marginBottom: 8,
              color: textPrimary,
            }}
          >
            {tr('onboardingTitle')}
          </Text>
          <Text style={{ color: textSecondary }}>
            {tr('onboardingSubtitle')}
          </Text>
        </Box>

        {/* 语言选择 */}
        <Box style={{ marginBottom: 32 }}>
          <Text 
            size="sm" 
            weight="bold" 
            style={{ 
              marginBottom: 12, 
              display: 'block',
              color: textSecondary,
            }}
          >
            {tr('selectLanguage')}
          </Text>
          <Box style={{ display: 'flex', gap: 12 }}>
            <Box
              className={`option-card ${language === 'zh' ? 'selected' : ''}`}
              onClick={() => handleLanguageChange('zh')}
              style={{
                flex: 1,
                padding: '16px 20px',
                borderRadius: 14,
                border: `1px solid ${language === 'zh' ? selectedBorder : optionBorder}`,
                background: language === 'zh' ? selectedBg : optionBg,
                textAlign: 'center',
              }}
            >
              <Text 
                size="lg" 
                weight={language === 'zh' ? 'bold' : 'medium'}
                style={{ color: language === 'zh' ? '#c9b8db' : textSecondary }}
              >
                {tr('chineseLabel')}
              </Text>
            </Box>
            <Box
              className={`option-card ${language === 'en' ? 'selected' : ''}`}
              onClick={() => handleLanguageChange('en')}
              style={{
                flex: 1,
                padding: '16px 20px',
                borderRadius: 14,
                border: `1px solid ${language === 'en' ? selectedBorder : optionBorder}`,
                background: language === 'en' ? selectedBg : optionBg,
                textAlign: 'center',
              }}
            >
              <Text 
                size="lg" 
                weight={language === 'en' ? 'bold' : 'medium'}
                style={{ color: language === 'en' ? '#c9b8db' : textSecondary }}
              >
                {tr('englishLabel')}
              </Text>
            </Box>
          </Box>
        </Box>

        {/* 主题选择 */}
        <Box style={{ marginBottom: 40 }}>
          <Text 
            size="sm" 
            weight="bold" 
            style={{ 
              marginBottom: 12, 
              display: 'block',
              color: textSecondary,
            }}
          >
            {tr('selectTheme')}
          </Text>
          <Box style={{ display: 'flex', gap: 12 }}>
            <Box
              className={`option-card ${theme === 'dark' ? 'selected' : ''}`}
              onClick={() => handleThemeChange('dark')}
              style={{
                flex: 1,
                padding: '16px 20px',
                borderRadius: 14,
                border: `1px solid ${theme === 'dark' ? selectedBorder : optionBorder}`,
                background: theme === 'dark' ? selectedBg : optionBg,
                textAlign: 'center',
              }}
            >
              <Box style={{ 
                width: 32, 
                height: 32, 
                margin: '0 auto 8px',
                borderRadius: '50%',
                background: '#1a1a2e',
                border: '2px solid var(--color-brand)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {/* 月亮图标 */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c9b8db" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              </Box>
              <Text 
                size="sm" 
                weight={theme === 'dark' ? 'bold' : 'medium'}
                style={{ color: theme === 'dark' ? '#c9b8db' : textSecondary }}
              >
                {tr('darkMode')}
              </Text>
            </Box>
            <Box
              className={`option-card ${theme === 'light' ? 'selected' : ''}`}
              onClick={() => handleThemeChange('light')}
              style={{
                flex: 1,
                padding: '16px 20px',
                borderRadius: 14,
                border: `1px solid ${theme === 'light' ? selectedBorder : optionBorder}`,
                background: theme === 'light' ? selectedBg : optionBg,
                textAlign: 'center',
              }}
            >
              <Box style={{ 
                width: 32, 
                height: 32, 
                margin: '0 auto 8px',
                borderRadius: '50%',
                background: '#f5f5f7',
                border: '2px solid var(--color-brand)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {/* 太阳图标 */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand)" strokeWidth="2">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              </Box>
              <Text 
                size="sm" 
                weight={theme === 'light' ? 'bold' : 'medium'}
                style={{ color: theme === 'light' ? 'var(--color-brand)' : textSecondary }}
              >
                {tr('lightMode')}
              </Text>
            </Box>
          </Box>
        </Box>

        {/* 继续按钮 */}
        <button
          className="continue-btn"
          onClick={handleContinue}
          style={{ 
            width: '100%',
            padding: '16px 24px',
            borderRadius: 14,
            border: 'none',
            background: 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
            color: '#fff',
            fontWeight: 700,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          {tr('continueButton')}
        </button>
      </Box>
    </Box>
  )
}
