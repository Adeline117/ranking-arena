'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Box, Text } from '@/app/components/base'
import { setLanguage, translations, type Language } from '@/lib/i18n'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'
import { tokens } from '@/lib/design-tokens'
import { lightTokens, darkTokens } from '@/lib/theme-tokens'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import Image from 'next/image'

type Theme = 'dark' | 'light'
type Step = 'welcome' | 'interests' | 'traders' | 'groups' | 'complete'

const STEPS: Step[] = ['welcome', 'interests', 'traders', 'groups', 'complete']

const INTERESTS = [
  { id: 'defi', labelKey: 'defi', icon: '\u2B21' },
  { id: 'cex', labelKey: 'interestCex', icon: '\u25C8' },
  { id: 'quant', labelKey: 'interestQuant', icon: '\u29D7' },
  { id: 'nft', labelKey: 'nft', icon: '\u25C7' },
  { id: 'layer2', labelKey: 'interestLayer2', icon: '\u25EB' },
  { id: 'onchain', labelKey: 'interestOnchain', icon: '\u25CE' },
  { id: 'futures', labelKey: 'futuresTrading', icon: '\u27E1' },
  { id: 'spot', labelKey: 'spotTrading', icon: '\u25C9' },
  { id: 'macro', labelKey: 'interestMacro', icon: '\u25A3' },
  { id: 'meme', labelKey: 'interestMeme', icon: '\u25CA' },
]

type Trader = {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  roi: number | null
  arena_score: number | null
}

type Group = {
  id: string
  name: string
  name_en: string | null
  description: string | null
  avatar_url: string | null
  member_count: number | null
}

const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('onboarding-styles')) return
  const style = document.createElement('style')
  style.id = 'onboarding-styles'
  style.textContent = `
    @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes stepEnter { from { opacity: 0; transform: translateX(30px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes celebrationBurst { 0% { transform: scale(0); opacity: 0; } 50% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
    @keyframes checkDraw { from { stroke-dashoffset: 50; } to { stroke-dashoffset: 0; } }
    @keyframes progressPulse { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(139, 111, 168, 0.4); } 50% { transform: scale(1.1); box-shadow: 0 0 0 8px rgba(139, 111, 168, 0); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .onboarding-bg { position: fixed; inset: 0; z-index: 0; transition: background 0.5s ease; }
    .onboarding-bg.dark { background: var(--color-bg-primary); }
    .onboarding-bg.light { background: linear-gradient(135deg, #f5f5f7 0%, #e8e8ed 50%, #f0f0f5 100%); }
    .onboarding-bg::before { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(ellipse at center, rgba(139, 111, 168, 0.08) 0%, transparent 50%); }
    .onboarding-card { animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
    .option-card { cursor: pointer; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
    .option-card:hover { transform: translateY(-2px); }
    .continue-btn { transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
    .continue-btn:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(139, 111, 168, 0.4); }
    .continue-btn:not(:disabled):active { transform: translateY(0) scale(0.98); }
    .step-content { animation: stepEnter 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
    .interest-card { transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); cursor: pointer; }
    .interest-card:hover { transform: translateY(-2px); }
    .progress-dot.active { animation: progressPulse 2s ease infinite; }
    .celebration-icon { animation: celebrationBurst 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
    .check-animation { stroke-dasharray: 50; stroke-dashoffset: 50; animation: checkDraw 0.5s ease 0.3s forwards; }
    .trader-row { transition: all 0.2s ease; cursor: default; }
    .trader-row:hover { background: rgba(139, 111, 168, 0.06); }
    .follow-btn { transition: all 0.2s ease; cursor: pointer; border: none; font-weight: 600; font-size: 13px; padding: 6px 16px; border-radius: 8px; }
    .follow-btn:hover { transform: scale(1.03); }
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

  // Traders & groups data
  const [traders, setTraders] = useState<Trader[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [followedTraders, setFollowedTraders] = useState<Set<string>>(new Set())
  const [joinedGroups, setJoinedGroups] = useState<Set<string>>(new Set())
  const [loadingTraders, setLoadingTraders] = useState(false)
  const [loadingGroups, setLoadingGroups] = useState(false)

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

    // Check if already onboarded
    if (localStorage.getItem('hasOnboarded') === 'true') {
      router.replace('/')
      return
    }

    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUserId(data.user.id)
      }
    })
  }, [router])

  // Fetch traders when entering that step
  const fetchTraders = useCallback(async () => {
    setLoadingTraders(true)
    try {
      const res = await fetch('/api/sidebar/top-traders')
      const data = await res.json()
      setTraders(data.traders || [])
    } catch {
      logger.error('Failed to fetch traders')
    } finally {
      setLoadingTraders(false)
    }
  }, [])

  // Fetch groups when entering that step
  const fetchGroups = useCallback(async () => {
    setLoadingGroups(true)
    try {
      const res = await fetch('/api/groups?limit=8&sort_by=member_count')
      const data = await res.json()
      const raw = data.data?.groups || data.data || data.groups || []
      setGroups(Array.isArray(raw) ? raw : [])
    } catch {
      logger.error('Failed to fetch groups')
    } finally {
      setLoadingGroups(false)
    }
  }, [])

  const handleLanguageChange = (lang: Language) => {
    setLang(lang)
    setLanguage(lang)
  }

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  const goToStep = (nextStep: Step) => {
    if (nextStep === 'traders') fetchTraders()
    if (nextStep === 'groups') fetchGroups()
    setStep(nextStep)
  }

  const toggleInterest = (id: string) => {
    setSelectedInterests(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    )
  }

  const handleFollowTrader = async (traderId: string) => {
    // Re-check auth if userId not yet set
    if (!userId) {
      const { data } = await supabase.auth.getUser()
      if (data?.user?.id) setUserId(data.user.id)
      else return
    }
    const isFollowed = followedTraders.has(traderId)
    const next = new Set(followedTraders)
    if (isFollowed) {
      next.delete(traderId)
    } else {
      next.add(traderId)
    }
    setFollowedTraders(next)
    try {
      await fetch('/api/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ traderId, action: isFollowed ? 'unfollow' : 'follow' }),
      })
    } catch {
      // revert on error
      setFollowedTraders(followedTraders)
    }
  }

  const handleJoinGroup = async (groupId: string) => {
    if (!userId) return
    const isJoined = joinedGroups.has(groupId)
    const next = new Set(joinedGroups)
    if (isJoined) {
      next.delete(groupId)
    } else {
      next.add(groupId)
    }
    setJoinedGroups(next)
    try {
      await fetch('/api/groups/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ groupId, action: isJoined ? 'leave' : 'join' }),
      })
    } catch {
      setJoinedGroups(joinedGroups)
    }
  }

  const saveAndComplete = async () => {
    setSaving(true)
    try {
      if (userId) {
        const updates: Record<string, unknown> = { onboarding_completed: true }
        if (selectedInterests.length > 0) {
          updates.interests = selectedInterests
        }
        const { error } = await supabase
          .from('user_profiles')
          .update(updates)
          .eq('id', userId)
        if (error) {
          logger.error('Error saving onboarding:', error)
        }
      }
      localStorage.setItem('hasOnboarded', 'true')
      setStep('complete')
    } catch (err) {
      logger.error('Error completing onboarding:', err)
      showToast(tr('saveFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleGoRankings = () => {
    router.push('/rankings')
  }

  if (!mounted) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 40, height: 40, border: '3px solid rgba(139, 111, 168, 0.2)', borderTopColor: 'var(--color-brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
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
  const brandGradient = 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)'

  const stepIndex = STEPS.indexOf(step)

  const formatTraderName = (t: Trader) => {
    const isAddress = (s: string) => /^0x[0-9a-fA-F]{10,}$/.test(s)
    const isLong = (s: string) => /^\d{10,}$/.test(s)
    const name = t.handle || t.source_trader_id
    if (isAddress(name)) return `${name.slice(0, 6)}...${name.slice(-4)}`
    if (isLong(name)) return `ID ${name.slice(-6)}`
    return name
  }

  return (
    <Box style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, position: 'relative', overflow: 'hidden' }}>
      <div className={`onboarding-bg ${theme}`} />

      <Box className="onboarding-card" style={{
        maxWidth: 560, width: '100%', background: cardBg, border: `1px solid ${cardBorder}`,
        borderRadius: 28, padding: '44px 36px', position: 'relative', zIndex: 1,
        boxShadow: isDark
          ? '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 100px rgba(139, 111, 168, 0.06)'
          : '0 25px 50px -12px rgba(0, 0, 0, 0.1), 0 0 100px rgba(139, 111, 168, 0.1)',
      }}>
        {/* Progress bar */}
        <Box style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 36 }}>
          {STEPS.map((s, i) => (
            <Box key={s} className={`progress-dot ${stepIndex === i ? 'active' : ''}`} style={{
              width: stepIndex === i ? 28 : 10, height: 10, borderRadius: 5,
              background: i <= stepIndex
                ? brandGradient
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

            <button className="continue-btn" onClick={() => goToStep('interests')} style={{
              width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none',
              background: brandGradient,
              color: tokens.colors.white, fontWeight: 700, fontSize: 16, cursor: 'pointer',
            }}>
              {tr('continueButton')}
            </button>
          </div>
        )}

        {/* Step 2: Interests */}
        {step === 'interests' && (
          <div key="interests" className="step-content">
            <Text size="2xl" weight="black" style={{
              marginBottom: 8, textAlign: 'center',
              background: `linear-gradient(135deg, ${textPrimary} 0%, #c9b8db 100%)`,
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {tr('selectInterests')}
            </Text>
            <Text style={{ marginBottom: 28, textAlign: 'center', color: textSecondary }}>
              {tr('selectInterestsDesc')}
            </Text>

            <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 32 }}>
              {INTERESTS.map(interest => {
                const isSelected = selectedInterests.includes(interest.id)
                return (
                  <Box key={interest.id} onClick={() => toggleInterest(interest.id)}
                    className={`interest-card ${isSelected ? 'selected' : ''}`}
                    style={{
                      padding: '14px 16px', borderRadius: 14,
                      border: isSelected ? `1px solid ${selectedBorder}` : `1px solid ${optionBorder}`,
                      background: isSelected ? selectedBg : optionBg,
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                    <span style={{ fontSize: 16, opacity: isSelected ? 1 : 0.5, transition: 'opacity 0.2s ease' }}>
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
              <button className="continue-btn" onClick={() => goToStep('traders')}
                style={{
                  flex: 1, padding: '14px 20px', borderRadius: 12,
                  border: `1px solid ${optionBorder}`, background: 'transparent',
                  color: textSecondary, fontWeight: 600, fontSize: 15, cursor: 'pointer',
                }}>
                {tr('skip')}
              </button>
              <button className="continue-btn" onClick={() => goToStep('traders')} style={{
                flex: 2, padding: '14px 20px', borderRadius: 12, border: 'none',
                background: brandGradient,
                color: tokens.colors.white, fontWeight: 700, fontSize: 15, cursor: 'pointer',
              }}>
                {tr('continueButton')}
              </button>
            </Box>
          </div>
        )}

        {/* Step 3: Follow Traders */}
        {step === 'traders' && (
          <div key="traders" className="step-content">
            <Text size="2xl" weight="black" style={{
              marginBottom: 8, textAlign: 'center',
              background: `linear-gradient(135deg, ${textPrimary} 0%, #c9b8db 100%)`,
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {tr('onboardingFollowTitle')}
            </Text>
            <Text style={{ marginBottom: 24, textAlign: 'center', color: textSecondary }}>
              {tr('onboardingFollowDesc')}
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 28, maxHeight: 340, overflowY: 'auto' }}>
              {loadingTraders ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} style={{ height: 52, borderRadius: 10, background: optionBg, marginBottom: 4 }} />
                ))
              ) : traders.length === 0 ? (
                <Text style={{ textAlign: 'center', color: textSecondary, padding: '20px 0' }}>
                  {language === 'zh' ? '暂无数据' : 'No data'}
                </Text>
              ) : (
                traders.slice(0, 10).map((t, idx) => {
                  const tid = `${t.source}:${t.source_trader_id}`
                  const isFollowed = followedTraders.has(tid)
                  return (
                    <Box key={tid} className="trader-row" style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                      borderRadius: 10,
                    }}>
                      {/* Rank */}
                      <span style={{
                        fontSize: 13, fontWeight: 800, minWidth: 20, textAlign: 'right',
                        color: idx < 3 ? ['#D4A843', '#A8A8A8', '#CD7F32'][idx] : textSecondary,
                      }}>
                        {idx + 1}
                      </span>
                      {/* Avatar */}
                      <Box style={{
                        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                        background: 'linear-gradient(135deg, rgba(139,111,168,0.3), rgba(212,168,67,0.3))',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 600, color: textPrimary, overflow: 'hidden',
                      }}>
                        {t.avatar_url ? (
                          <Image src={t.avatar_url} alt="" width={36} height={36} loading="lazy" unoptimized style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
                        ) : (
                          (formatTraderName(t)).charAt(0).toUpperCase()
                        )}
                      </Box>
                      {/* Name + score */}
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" weight="semibold" style={{
                          color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {formatTraderName(t)}
                        </Text>
                        <Text size="xs" style={{ color: textSecondary }}>
                          {t.arena_score != null ? `${(language === 'zh' ? '分数' : 'Score')} ${t.arena_score.toFixed(0)}` : t.source}
                        </Text>
                      </Box>
                      {/* Follow button */}
                      <button className="follow-btn" onClick={() => handleFollowTrader(tid)}
                        style={{
                          background: isFollowed ? optionBg : brandGradient,
                          color: isFollowed ? textSecondary : '#fff',
                          border: isFollowed ? `1px solid ${optionBorder}` : 'none',
                        }}>
                        {isFollowed ? tr('onboardingFollowedBtn') : tr('onboardingFollowBtn')}
                      </button>
                    </Box>
                  )
                })
              )}
            </Box>

            <Box style={{ display: 'flex', gap: 14 }}>
              <button className="continue-btn" onClick={() => goToStep('groups')}
                style={{
                  flex: 1, padding: '14px 20px', borderRadius: 12,
                  border: `1px solid ${optionBorder}`, background: 'transparent',
                  color: textSecondary, fontWeight: 600, fontSize: 15, cursor: 'pointer',
                }}>
                {tr('skip')}
              </button>
              <button className="continue-btn" onClick={() => goToStep('groups')} style={{
                flex: 2, padding: '14px 20px', borderRadius: 12, border: 'none',
                background: brandGradient,
                color: tokens.colors.white, fontWeight: 700, fontSize: 15, cursor: 'pointer',
              }}>
                {tr('continueButton')}
              </button>
            </Box>
          </div>
        )}

        {/* Step 4: Join Groups */}
        {step === 'groups' && (
          <div key="groups" className="step-content">
            <Text size="2xl" weight="black" style={{
              marginBottom: 8, textAlign: 'center',
              background: `linear-gradient(135deg, ${textPrimary} 0%, #c9b8db 100%)`,
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {tr('onboardingGroupTitle')}
            </Text>
            <Text style={{ marginBottom: 24, textAlign: 'center', color: textSecondary }}>
              {tr('onboardingGroupDesc')}
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28, maxHeight: 340, overflowY: 'auto' }}>
              {loadingGroups ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} style={{ height: 60, borderRadius: 14, background: optionBg }} />
                ))
              ) : groups.length === 0 ? (
                <Text style={{ textAlign: 'center', color: textSecondary, padding: '20px 0' }}>
                  {language === 'zh' ? '暂无小组' : 'No groups yet'}
                </Text>
              ) : (
                groups.map(g => {
                  const isJoined = joinedGroups.has(g.id)
                  const displayName = language === 'zh' ? g.name : (g.name_en || g.name)
                  return (
                    <Box key={g.id} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                      borderRadius: 14, border: `1px solid ${optionBorder}`, background: optionBg,
                    }}>
                      {/* Avatar */}
                      <Box style={{
                        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                        background: 'linear-gradient(135deg, rgba(139,111,168,0.3), rgba(212,168,67,0.3))',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 16, fontWeight: 600, color: textPrimary, overflow: 'hidden',
                      }}>
                        {g.avatar_url ? (
                          <Image src={g.avatar_url} alt="" width={40} height={40} loading="lazy" unoptimized style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover' }} />
                        ) : (
                          displayName.charAt(0).toUpperCase()
                        )}
                      </Box>
                      {/* Name + members */}
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" weight="semibold" style={{
                          color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {displayName}
                        </Text>
                        {g.member_count != null && (
                          <Text size="xs" style={{ color: textSecondary }}>
                            {g.member_count} {language === 'zh' ? '成员' : 'members'}
                          </Text>
                        )}
                      </Box>
                      {/* Join button */}
                      <button className="follow-btn" onClick={() => handleJoinGroup(g.id)}
                        style={{
                          background: isJoined ? optionBg : brandGradient,
                          color: isJoined ? textSecondary : '#fff',
                          border: isJoined ? `1px solid ${optionBorder}` : 'none',
                        }}>
                        {isJoined ? tr('onboardingJoinedBtn') : tr('onboardingJoinBtn')}
                      </button>
                    </Box>
                  )
                })
              )}
            </Box>

            <button className="continue-btn" onClick={saveAndComplete} disabled={saving} style={{
              width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none',
              background: saving ? 'rgba(139, 111, 168, 0.2)' : brandGradient,
              color: tokens.colors.white, fontWeight: 700, fontSize: 16,
              cursor: saving ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
              {saving && <div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />}
              {saving ? tr('saving') : tr('continueButton')}
            </button>
          </div>
        )}

        {/* Step 5: Complete */}
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
              {tr('onboardingDoneTitle')}
            </Text>
            <Text style={{ marginBottom: 36, color: textSecondary }}>
              {tr('onboardingDoneDesc')}
            </Text>

            <button className="continue-btn" onClick={handleGoRankings} style={{
              width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none',
              background: brandGradient,
              color: tokens.colors.white, fontWeight: 700, fontSize: 16, cursor: 'pointer',
            }}>
              {tr('onboardingGoRankings')}
            </button>
          </div>
        )}
      </Box>
    </Box>
  )
}
