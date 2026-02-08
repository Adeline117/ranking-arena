'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Box, Text } from '@/app/components/base'
import { setLanguage, translations, type Language } from '@/lib/i18n'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'
import { tokens } from '@/lib/design-tokens'
import { lightTokens, darkTokens } from '@/lib/theme-tokens'

type Theme = 'dark' | 'light'
type Step = 'welcome' | 'features' | 'interests' | 'complete'

const interests = [
  { id: 'btc', labelKey: 'btcTrading', icon: '₿' },
  { id: 'eth', labelKey: 'ethTrading', icon: 'Ξ' },
  { id: 'altcoin', labelKey: 'altcoins', icon: '◈' },
  { id: 'futures', labelKey: 'futuresTrading', icon: '⟡' },
  { id: 'spot', labelKey: 'spotTrading', icon: '◉' },
  { id: 'defi', labelKey: 'defi', icon: '⬡' },
  { id: 'nft', labelKey: 'nft', icon: '◇' },
  { id: 'analysis', labelKey: 'technicalAnalysis', icon: '' },
]

const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('onboarding-styles')) return
  const style = document.createElement('style')
  style.id = 'onboarding-styles'
  style.textContent = `
    @keyframes onboardingGradient { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.02); } }
    @keyframes stepEnter { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes celebrationBurst { 0% { transform: scale(0); opacity: 0; } 50% { transform: scale(1.2); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
    @keyframes checkDraw { from { stroke-dashoffset: 50; } to { stroke-dashoffset: 0; } }
    @keyframes progressPulse { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(139, 111, 168, 0.4); } 50% { transform: scale(1.1); box-shadow: 0 0 0 8px rgba(139, 111, 168, 0); } }
    .onboarding-bg { position: fixed; inset: 0; z-index: 0; transition: background 0.5s ease; }
    .onboarding-bg.dark { background: linear-gradient(135deg, #0a0a0f 0%, #13111a 50%, #0f0d14 100%); }
    .onboarding-bg.light { background: linear-gradient(135deg, #f5f5f7 0%, #e8e8ed 50%, #f0f0f5 100%); }
    .onboarding-bg::before { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(ellipse at center, rgba(139, 111, 168, 0.08) 0%, transparent 50%); animation: onboardingGradient 20s ease infinite; }
    .onboarding-card { animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
    .option-card { cursor: pointer; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
    .option-card:hover { transform: translateY(-2px); }
    .option-card.selected { animation: pulse 2s ease infinite; }
    .continue-btn { transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
    .continue-btn:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(139, 111, 168, 0.4); }
    .continue-btn:not(:disabled):active { transform: translateY(0) scale(0.98); }
    .floating-particle { position: absolute; border-radius: 50%; animation: float 6s ease-in-out infinite; }
    @keyframes float { 0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.3; } 50% { transform: translateY(-15px) rotate(180deg); opacity: 0.5; } }
    .step-content { animation: stepEnter 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
    .interest-card { transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); cursor: pointer; }
    .interest-card:hover { transform: translateY(-2px); }
    .progress-dot.active { animation: progressPulse 2s ease infinite; }
    .celebration-icon { animation: celebrationBurst 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
    .check-animation { stroke-dasharray: 50; stroke-dashoffset: 50; animation: checkDraw 0.5s ease 0.3s forwards; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `
  document.head.appendChild(style)
}

export default function OnboardingPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const [language, setLang] = useState<Language>('zh')
  const [theme, setTheme] = useState<Theme>('dark')
  const [mounted, setMounted] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [selectedInterests, setSelectedInterests] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)

  const tr = (key: string) => translations[language][key] || translations.zh[key] || key

  useEffect(() => {
    injectStyles()
    setMounted(true)

    const savedLang = localStorage.getItem('language') as Language | null
    const savedTheme = localStorage.getItem('theme') as Theme | null
    if (savedLang) setLang(savedLang)
    if (savedTheme) {
      setTheme(savedTheme)
      document.documentElement.setAttribute('data-theme', savedTheme)
    }

    // Check if logged in user has completed onboarding
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUserId(data.user.id)
      }
    })
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

  const goToFeatures = () => {
    setLanguage(language)
    localStorage.setItem('theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
    setStep('features')
  }

  const goToInterests = () => {
    setStep('interests')
  }

  const toggleInterest = (id: string) => {
    setSelectedInterests(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    )
  }

  const saveAndComplete = async (withInterests: boolean) => {
    setSaving(true)
    try {
      if (userId) {
        const updates: Record<string, unknown> = { onboarding_completed: true }
        if (withInterests && selectedInterests.length > 0) {
          updates.interests = selectedInterests
        }
        const { error } = await supabase
          .from('user_profiles')
          .update(updates)
          .eq('id', userId)
        if (error) {
          console.error('Error saving onboarding:', error)
        }
      }
      localStorage.setItem('hasOnboarded', 'true')
      setStep('complete')
    } catch (err) {
      console.error('Error completing onboarding:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleGoHome = () => {
    router.push('/')
  }

  if (!mounted) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 40, height: 40, border: '3px solid rgba(139, 111, 168, 0.2)', borderTopColor: 'var(--color-brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
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

  const stepIndex = step === 'welcome' ? 0 : step === 'features' ? 1 : step === 'interests' ? 2 : 3

  return (
    <Box style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, position: 'relative', overflow: 'hidden' }}>
      <div className={`onboarding-bg ${theme}`} />

      {[...Array(5)].map((_, i) => (
        <div key={i} className="floating-particle" style={{
          width: 6 + i * 3, height: 6 + i * 3, left: `${15 + i * 18}%`, top: `${25 + (i % 3) * 20}%`,
          background: `linear-gradient(135deg, rgba(139, 111, 168, ${isDark ? 0.3 : 0.2}), rgba(139, 111, 168, 0.1))`,
          animationDelay: `${i * 0.7}s`, animationDuration: `${5 + i}s`,
        }} />
      ))}

      <Box className="onboarding-card" style={{
        maxWidth: 540, width: '100%', background: cardBg, border: `1px solid ${cardBorder}`,
        borderRadius: 28, padding: '48px 40px', position: 'relative', zIndex: 1,
        boxShadow: isDark
          ? '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 100px rgba(139, 111, 168, 0.06)'
          : '0 25px 50px -12px rgba(0, 0, 0, 0.1), 0 0 100px rgba(139, 111, 168, 0.1)',
      }}>
        {/* Progress dots */}
        <Box style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 40 }}>
          {['welcome', 'features', 'interests', 'complete'].map((s, i) => (
            <Box key={s} className={`progress-dot ${stepIndex === i ? 'active' : ''}`} style={{
              width: stepIndex === i ? 28 : 10, height: 10, borderRadius: 5,
              background: i <= stepIndex
                ? 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)'
                : isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
              transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
            }} />
          ))}
        </Box>

        {/* Step 1: Welcome + Language/Theme */}
        {step === 'welcome' && (
          <div key="welcome" className="step-content">
            <Box style={{ textAlign: 'center', marginBottom: 32 }}>
              <Text size="3xl" weight="black" style={{
                marginBottom: 8,
                background: 'linear-gradient(135deg, var(--color-brand) 0%, #c9b8db 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>
                Arena
              </Text>
              <Text size="xl" weight="bold" style={{ marginBottom: 8, color: textPrimary }}>
                {tr('onboardingTitle')}
              </Text>
              <Text style={{ color: textSecondary }}>
                {tr('onboardingSubtitle')}
              </Text>
            </Box>

            {/* Language */}
            <Box style={{ marginBottom: 24 }}>
              <Text size="sm" weight="bold" style={{ marginBottom: 12, display: 'block', color: textSecondary }}>
                {tr('selectLanguage')}
              </Text>
              <Box style={{ display: 'flex', gap: 12 }}>
                {(['zh', 'en'] as Language[]).map(lang => (
                  <Box key={lang} className={`option-card ${language === lang ? 'selected' : ''}`}
                    onClick={() => handleLanguageChange(lang)}
                    style={{
                      flex: 1, padding: '16px 20px', borderRadius: 14,
                      border: `1px solid ${language === lang ? selectedBorder : optionBorder}`,
                      background: language === lang ? selectedBg : optionBg, textAlign: 'center',
                    }}>
                    <Text size="lg" weight={language === lang ? 'bold' : 'medium'}
                      style={{ color: language === lang ? '#c9b8db' : textSecondary }}>
                      {lang === 'zh' ? tr('chineseLabel') : tr('englishLabel')}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>

            {/* Theme */}
            <Box style={{ marginBottom: 32 }}>
              <Text size="sm" weight="bold" style={{ marginBottom: 12, display: 'block', color: textSecondary }}>
                {tr('selectTheme')}
              </Text>
              <Box style={{ display: 'flex', gap: 12 }}>
                {(['dark', 'light'] as Theme[]).map(t => (
                  <Box key={t} className={`option-card ${theme === t ? 'selected' : ''}`}
                    onClick={() => handleThemeChange(t)}
                    style={{
                      flex: 1, padding: '16px 20px', borderRadius: 14,
                      border: `1px solid ${theme === t ? selectedBorder : optionBorder}`,
                      background: theme === t ? selectedBg : optionBg, textAlign: 'center',
                    }}>
                    <Box style={{
                      width: 32, height: 32, margin: '0 auto 8px', borderRadius: '50%',
                      background: t === 'dark' ? darkTokens.colors.bg.secondary : lightTokens.colors.bg.secondary,
                      border: '2px solid var(--color-brand)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {t === 'dark' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c9b8db" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand)" strokeWidth="2">
                          <circle cx="12" cy="12" r="5" />
                          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                        </svg>
                      )}
                    </Box>
                    <Text size="sm" weight={theme === t ? 'bold' : 'medium'}
                      style={{ color: theme === t ? (t === 'dark' ? '#c9b8db' : 'var(--color-brand)') : textSecondary }}>
                      {t === 'dark' ? tr('darkMode') : tr('lightMode')}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>

            <button className="continue-btn" onClick={goToFeatures} style={{
              width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none',
              background: 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
              color: '#fff', fontWeight: 700, fontSize: 16, cursor: 'pointer',
            }}>
              {tr('continueButton')}
            </button>
          </div>
        )}

        {/* Step 2: Feature introduction */}
        {step === 'features' && (
          <div key="features" className="step-content">
            <Text size="2xl" weight="black" style={{
              marginBottom: 8, textAlign: 'center',
              background: `linear-gradient(135deg, ${textPrimary} 0%, #c9b8db 100%)`,
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {tr('onboardingFeatureTitle')}
            </Text>
            <Text style={{ marginBottom: 28, textAlign: 'center', color: textSecondary }}>
              {tr('onboardingFeatureSubtitle')}
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 32 }}>
              {[
                { titleKey: 'onboardingFeature1Title', descKey: 'onboardingFeature1Desc', icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                )},
                { titleKey: 'onboardingFeature2Title', descKey: 'onboardingFeature2Desc', icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1" y="3" width="8" height="18" rx="2" />
                    <rect x="15" y="3" width="8" height="18" rx="2" />
                  </svg>
                )},
                { titleKey: 'onboardingFeature3Title', descKey: 'onboardingFeature3Desc', icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                )},
              ].map((feature) => (
                <Box key={feature.titleKey} style={{
                  display: 'flex', gap: 14, padding: '16px 18px', borderRadius: 14,
                  border: `1px solid ${optionBorder}`, background: optionBg,
                }}>
                  <Box style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(139, 111, 168, 0.1)' }}>
                    {feature.icon}
                  </Box>
                  <Box>
                    <Text size="sm" weight="bold" style={{ color: textPrimary, marginBottom: 4 }}>
                      {tr(feature.titleKey)}
                    </Text>
                    <Text size="xs" style={{ color: textSecondary, lineHeight: 1.4 }}>
                      {tr(feature.descKey)}
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>

            <Box style={{ display: 'flex', gap: 14 }}>
              <button className="continue-btn" onClick={() => { saveAndComplete(false) }} disabled={saving}
                style={{
                  flex: 1, padding: '14px 20px', borderRadius: 12,
                  border: `1px solid ${optionBorder}`, background: 'transparent',
                  color: textSecondary, fontWeight: 600, fontSize: 15,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}>
                {tr('skip') || 'Skip'}
              </button>
              <button className="continue-btn" onClick={goToInterests} style={{
                flex: 2, padding: '14px 20px', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer',
              }}>
                {tr('continueButton')}
              </button>
            </Box>
          </div>
        )}

        {/* Step 3: Interest selection */}
        {step === 'interests' && (
          <div key="interests" className="step-content">
            <Text size="2xl" weight="black" style={{
              marginBottom: 8, textAlign: 'center',
              background: `linear-gradient(135deg, ${textPrimary} 0%, #c9b8db 100%)`,
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {tr('selectInterests') || '选择你的兴趣'}
            </Text>
            <Text style={{ marginBottom: 32, textAlign: 'center', color: textSecondary }}>
              {tr('selectInterestsDesc') || '帮助我们为你推荐更好的内容'}
            </Text>

            <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginBottom: 36 }}>
              {interests.map(interest => {
                const isSelected = selectedInterests.includes(interest.id)
                return (
                  <Box key={interest.id} onClick={() => toggleInterest(interest.id)}
                    className={`interest-card ${isSelected ? 'selected' : ''}`}
                    style={{
                      padding: '16px 18px', borderRadius: 14,
                      border: isSelected ? `1px solid ${selectedBorder}` : `1px solid ${optionBorder}`,
                      background: isSelected ? selectedBg : optionBg,
                      display: 'flex', alignItems: 'center', gap: 12,
                    }}>
                    <span style={{ fontSize: 18, opacity: isSelected ? 1 : 0.6, transition: 'opacity 0.2s ease' }}>
                      {interest.icon}
                    </span>
                    <Text size="sm" weight={isSelected ? 'bold' : 'medium'}
                      style={{ color: isSelected ? '#c9b8db' : textSecondary }}>
                      {tr(interest.labelKey)}
                    </Text>
                  </Box>
                )
              })}
            </Box>

            <Box style={{ display: 'flex', gap: 14 }}>
              <button className="continue-btn" onClick={() => saveAndComplete(false)} disabled={saving}
                style={{
                  flex: 1, padding: '14px 20px', borderRadius: 12,
                  border: `1px solid ${optionBorder}`, background: 'transparent',
                  color: textSecondary, fontWeight: 600, fontSize: 15,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}>
                {tr('skip') || '跳过'}
              </button>
              <button className="continue-btn" onClick={() => saveAndComplete(true)} disabled={saving}
                style={{
                  flex: 2, padding: '14px 20px', borderRadius: 12, border: 'none',
                  background: saving ? 'rgba(139, 111, 168, 0.2)' : 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                  color: '#fff', fontWeight: 700, fontSize: 15,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>
                {saving && <div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />}
                {saving ? (tr('saving') || '保存中...') : (tr('complete') || '完成')}
              </button>
            </Box>
          </div>
        )}

        {/* Step 3: Complete */}
        {step === 'complete' && (
          <div key="complete" className="step-content" style={{ textAlign: 'center' }}>
            <Box className="celebration-icon" style={{
              width: 80, height: 80, borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(139, 111, 168, 0.3) 0%, rgba(139, 111, 168, 0.1) 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 28px', boxShadow: '0 0 40px rgba(139, 111, 168, 0.3)',
            }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c9b8db" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline className="check-animation" points="20 6 9 17 4 12" />
              </svg>
            </Box>
            <Text size="2xl" weight="black" style={{
              marginBottom: 12,
              background: `linear-gradient(135deg, ${textPrimary} 0%, #c9b8db 100%)`,
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {tr('setupComplete') || '设置完成！'}
            </Text>
            <Text style={{ marginBottom: 36, color: textSecondary }}>
              {tr('welcomeToArena') || '欢迎来到 Arena，开始你的探索之旅'}
            </Text>

            <button className="continue-btn" onClick={handleGoHome} style={{
              width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none',
              background: 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
              color: '#fff', fontWeight: 700, fontSize: 16, cursor: 'pointer',
            }}>
              {tr('exploreRanking') || '开始探索'}
            </button>
          </div>
        )}
      </Box>
    </Box>
  )
}
