'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Box } from '@/app/components/base'
import { setLanguage, translations, type Language } from '@/lib/i18n'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'
import { tokens } from '@/lib/design-tokens'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import type { OnboardingTheme, Trader, Group } from './components/types'
import WelcomeStep from './components/WelcomeStep'
import InterestsStep from './components/InterestsStep'
import TradersStep from './components/TradersStep'
import GroupsStep from './components/GroupsStep'
import CompleteStep from './components/CompleteStep'

type Theme = 'dark' | 'light'
type Step = 'welcome' | 'interests' | 'traders' | 'groups' | 'complete'

const STEPS: Step[] = ['welcome', 'interests', 'traders', 'groups', 'complete']

// Onboarding styles moved to globals.css (#32) — no DOM injection needed

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

  const [traders, setTraders] = useState<Trader[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [followedTraders, setFollowedTraders] = useState<Set<string>>(new Set())
  const [joinedGroups, setJoinedGroups] = useState<Set<string>>(new Set())
  const [loadingTraders, setLoadingTraders] = useState(false)
  const [loadingGroups, setLoadingGroups] = useState(false)

  const tr = (key: string) => translations[language][key] || translations.en[key] || key

  useEffect(() => {
    setMounted(true)
    const savedLang = localStorage.getItem('language') as Language | null
    const savedTheme = localStorage.getItem('theme') as Theme | null
    if (savedLang) setLang(savedLang)
    if (savedTheme) {
      setTheme(savedTheme)
      document.documentElement.setAttribute('data-theme', savedTheme)
    }
    if (localStorage.getItem('hasOnboarded') === 'true') {
      router.replace('/')
      return
    }
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUserId(data.user.id)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for onboarding */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [router])

  const fetchTraders = useCallback(async () => {
    setLoadingTraders(true)
    try {
      const res = await fetch('/api/sidebar/top-traders')
      const data = await res.json()
      setTraders(data.traders || [])
    } catch { logger.error('Failed to fetch traders') }
    finally { setLoadingTraders(false) }
  }, [])

  const fetchGroups = useCallback(async () => {
    setLoadingGroups(true)
    try {
      const res = await fetch('/api/groups?limit=8&sort_by=member_count')
      const data = await res.json()
      const raw = data.data?.groups || data.data || data.groups || []
      setGroups(Array.isArray(raw) ? raw : [])
    } catch { logger.error('Failed to fetch groups') }
    finally { setLoadingGroups(false) }
  }, [])

  const handleLanguageChange = (lang: Language) => { setLang(lang); setLanguage(lang) }
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

  // Keyboard navigation: Enter to continue, Escape to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === 'Enter') {
        e.preventDefault()
        const _stepIndex = STEPS.indexOf(step)
        if (step === 'welcome') goToStep('interests')
        else if (step === 'interests') goToStep('traders')
        else if (step === 'traders') goToStep('groups')
        else if (step === 'groups' && !saving) saveAndComplete()
        else if (step === 'complete') router.push('/rankings')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (step === 'interests') goToStep('welcome')
        else if (step === 'traders') goToStep('interests')
        else if (step === 'groups') goToStep('traders')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [step, saving]) // eslint-disable-line react-hooks/exhaustive-deps -- goToStep/saveAndComplete/router are stable

  const toggleInterest = (id: string) => {
    setSelectedInterests(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id])
  }

  // Batch follow/join: queue actions and flush in parallel after a debounce
  const followQueueRef = useRef<Map<string, 'follow' | 'unfollow'>>(new Map())
  const joinQueueRef = useRef<Map<string, 'join' | 'leave'>>(new Map())
  const followFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const joinFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushFollowQueue = useCallback(() => {
    const queue = new Map(followQueueRef.current)
    followQueueRef.current.clear()
    if (queue.size === 0) return
    const promises = Array.from(queue.entries()).map(([traderId, action]) =>
      fetch('/api/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ traderId, action }),
      }).catch(() => { /* swallow individual failures; UI already updated optimistically */ }) // eslint-disable-line no-restricted-syntax -- fire-and-forget
    )
    Promise.all(promises)
  }, [])

  const flushJoinQueue = useCallback(() => {
    const queue = new Map(joinQueueRef.current)
    joinQueueRef.current.clear()
    if (queue.size === 0) return
    const promises = Array.from(queue.entries()).map(([groupId, action]) =>
      fetch('/api/groups/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ groupId, action }),
      }).catch(() => { /* swallow individual failures; UI already updated optimistically */ }) // eslint-disable-line no-restricted-syntax -- fire-and-forget
    )
    Promise.all(promises)
  }, [])

  const handleFollowTrader = async (traderId: string) => {
    if (!userId) {
      const { data } = await supabase.auth.getUser()
      if (data?.user?.id) setUserId(data.user.id)
      else return
    }
    const isFollowed = followedTraders.has(traderId)
    const next = new Set(followedTraders)
    if (isFollowed) next.delete(traderId); else next.add(traderId)
    setFollowedTraders(next)
    // Queue the action and debounce the flush
    followQueueRef.current.set(traderId, isFollowed ? 'unfollow' : 'follow')
    if (followFlushTimerRef.current) clearTimeout(followFlushTimerRef.current)
    followFlushTimerRef.current = setTimeout(flushFollowQueue, 500)
  }

  const handleJoinGroup = async (groupId: string) => {
    if (!userId) return
    const isJoined = joinedGroups.has(groupId)
    const next = new Set(joinedGroups)
    if (isJoined) next.delete(groupId); else next.add(groupId)
    setJoinedGroups(next)
    // Queue the action and debounce the flush
    joinQueueRef.current.set(groupId, isJoined ? 'leave' : 'join')
    if (joinFlushTimerRef.current) clearTimeout(joinFlushTimerRef.current)
    joinFlushTimerRef.current = setTimeout(flushJoinQueue, 500)
  }

  // Flush any remaining queued actions on unmount
  useEffect(() => {
    return () => {
      if (followFlushTimerRef.current) clearTimeout(followFlushTimerRef.current)
      if (joinFlushTimerRef.current) clearTimeout(joinFlushTimerRef.current)
      flushFollowQueue()
      flushJoinQueue()
    }
  }, [flushFollowQueue, flushJoinQueue])

  const saveAndComplete = async () => {
    setSaving(true)
    try {
      if (userId) {
        const updates: Record<string, unknown> = { onboarding_completed: true }
        if (selectedInterests.length > 0) updates.interests = selectedInterests
        const { error } = await supabase.from('user_profiles').update(updates).eq('id', userId)
        if (error) logger.error('Error saving onboarding:', error)
      }
      localStorage.setItem('hasOnboarded', 'true')
      setStep('complete')
    } catch (err) {
      logger.error('Error completing onboarding:', err)
      showToast(tr('saveFailed'), 'error')
    } finally { setSaving(false) }
  }

  if (!mounted) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 40, height: 40, border: '3px solid var(--color-accent-primary-20)', borderTopColor: 'var(--color-brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      </Box>
    )
  }

  const isDark = theme === 'dark'
  const obTheme: OnboardingTheme = {
    isDark,
    cardBg: isDark ? 'var(--color-backdrop-heavy)' : 'var(--glass-bg-heavy)',
    cardBorder: isDark ? 'var(--color-accent-primary-15)' : 'var(--color-accent-primary-20)',
    textPrimary: isDark ? 'var(--color-bg-tertiary)' : 'var(--color-text-primary)',
    textSecondary: 'var(--color-text-secondary)',
    optionBg: isDark ? 'var(--color-overlay-medium)' : 'var(--color-overlay-subtle)',
    optionBorder: isDark ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)',
    selectedBg: isDark
      ? 'linear-gradient(135deg, var(--color-accent-primary-30) 0%, var(--color-accent-primary-15) 100%)'
      : 'linear-gradient(135deg, var(--color-accent-primary-20) 0%, var(--color-accent-primary-10) 100%)',
    selectedBorder: 'var(--color-accent-primary-60)',
    brandGradient: 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
  }

  const stepIndex = STEPS.indexOf(step)

  return (
    <Box style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, position: 'relative', overflow: 'hidden' }}>
      <div className={`onboarding-bg ${theme}`} />

      <Box className="onboarding-card" style={{
        maxWidth: 560, width: '100%', background: obTheme.cardBg, border: `1px solid ${obTheme.cardBorder}`,
        borderRadius: 28, padding: 'clamp(24px, 5vw, 44px) clamp(20px, 4vw, 36px)', position: 'relative', zIndex: 1,
        boxShadow: isDark
          ? '0 25px 50px -12px var(--color-overlay-dark), 0 0 100px var(--color-notification-unread)'
          : '0 25px 50px -12px var(--color-overlay-subtle), 0 0 100px var(--color-accent-primary-10)',
      }}>
        {/* Progress bar - hidden on complete step */}
        <Box style={{ display: step === 'complete' ? 'none' : 'flex', justifyContent: 'center', gap: 10, marginBottom: 36 }}>
          {STEPS.map((s, i) => (
            <Box key={s} className={`progress-dot ${stepIndex === i ? 'active' : ''}`} style={{
              width: stepIndex === i ? 28 : 10, height: 10, borderRadius: 5,
              background: i <= stepIndex
                ? obTheme.brandGradient
                : isDark ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)',
              transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
            }} />
          ))}
        </Box>

        {step === 'welcome' && (
          <WelcomeStep theme={obTheme} language={language} currentTheme={theme} tr={tr}
            onLanguageChange={handleLanguageChange} onThemeChange={handleThemeChange}
            onContinue={() => goToStep('interests')} />
        )}
        {step === 'interests' && (
          <InterestsStep theme={obTheme} selectedInterests={selectedInterests} tr={tr}
            onToggleInterest={toggleInterest} onBack={() => goToStep('welcome')}
            onContinue={() => goToStep('traders')} />
        )}
        {step === 'traders' && (
          <TradersStep theme={obTheme} language={language} traders={traders}
            followedTraders={followedTraders} loadingTraders={loadingTraders} tr={tr}
            onFollowTrader={handleFollowTrader} onBack={() => goToStep('interests')}
            onContinue={() => goToStep('groups')} />
        )}
        {step === 'groups' && (
          <GroupsStep theme={obTheme} language={language} groups={groups}
            joinedGroups={joinedGroups} loadingGroups={loadingGroups} saving={saving} tr={tr}
            onJoinGroup={handleJoinGroup} onBack={() => goToStep('traders')}
            onComplete={saveAndComplete} />
        )}
        {step === 'complete' && (
          <CompleteStep theme={obTheme} tr={tr} onGoRankings={() => router.push('/rankings')} />
        )}
      </Box>
    </Box>
  )
}
