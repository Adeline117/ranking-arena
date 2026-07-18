'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
import {
  OnboardingMembershipIntentLedger,
  OnboardingMembershipRequestSequencer,
  rollbackOnboardingMembershipIntent,
  sendOnboardingMembershipIntent,
  type OnboardingMembershipIntent,
  type OnboardingMembershipScope,
} from './membership-intent'
import { trackEvent } from '@/lib/analytics/track'
import { safeInternalReturnPath } from '@/lib/auth/safe-return-path'

type Theme = 'dark' | 'light'
type Step = 'welcome' | 'interests' | 'traders' | 'groups' | 'complete'

const STEPS: Step[] = ['welcome', 'interests', 'traders', 'groups', 'complete']

// Onboarding styles moved to globals.css (#32) — no DOM injection needed

export default function OnboardingPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const returnUrl = searchParams.get('returnUrl')
  const afterOnboarding = safeInternalReturnPath(returnUrl) || '/'
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
  const startedRef = useRef(false)
  const joinedGroupsRef = useRef(joinedGroups)
  const languageRef = useRef(language)
  const showToastRef = useRef(showToast)
  const membershipScopeRef = useRef<OnboardingMembershipScope>({
    active: true,
    revision: 0,
    viewerId: null,
  })
  const membershipIntentLedgerRef = useRef(new OnboardingMembershipIntentLedger())
  const membershipRequestSequencerRef = useRef(new OnboardingMembershipRequestSequencer())
  const membershipSettlingRef = useRef(false)

  const tr = (key: string) => translations[language][key] || translations.en[key] || key

  useEffect(() => {
    joinedGroupsRef.current = joinedGroups
  }, [joinedGroups])

  useEffect(() => {
    languageRef.current = language
  }, [language])

  useEffect(() => {
    showToastRef.current = showToast
  }, [showToast])

  useEffect(() => {
    const currentScope = membershipScopeRef.current
    if (currentScope.viewerId !== userId) {
      membershipScopeRef.current = {
        active: true,
        revision: currentScope.revision + 1,
        viewerId: userId,
      }
    }
  }, [userId])

  useEffect(() => {
    return () => {
      const currentScope = membershipScopeRef.current
      membershipScopeRef.current = {
        active: false,
        revision: currentScope.revision + 1,
        viewerId: null,
      }
    }
  }, [])

  useEffect(() => {
    setMounted(true)
    if (!startedRef.current) {
      startedRef.current = true
      trackEvent('onboarding_start')
    }
    const savedLang = localStorage.getItem('language') as Language | null
    const savedTheme = localStorage.getItem('theme') as Theme | null
    if (savedLang) setLang(savedLang)
    if (savedTheme) {
      setTheme(savedTheme)
      document.documentElement.setAttribute('data-theme', savedTheme)
    }
    // Fast path: the local flag short-circuits a re-onboard on the same device.
    if (localStorage.getItem('hasOnboarded') === 'true') {
      router.replace(afterOnboarding)
      return
    }
    supabase.auth
      .getUser()
      .then(async ({ data }) => {
        if (!data.user) {
          router.replace('/login?returnUrl=/onboarding')
          return
        }
        setUserId(data.user.id)
        // DB onboarding_completed is the authoritative source: a user who already
        // finished onboarding (possibly on another device, where localStorage is
        // empty) must not be re-onboarded. Hydrate the local flag from it.
        try {
          const { data: profile, error } = await supabase
            .from('user_profiles')
            .select('onboarding_completed')
            .eq('id', data.user.id)
            .maybeSingle()
          if (error) {
            logger.warn('Onboarding flag read failed', error)
          } else if (profile?.onboarding_completed === true) {
            try {
              localStorage.setItem('hasOnboarded', 'true')
            } catch {
              /* localStorage may be unavailable */
            }
            router.replace(afterOnboarding)
          }
        } catch (err) {
          logger.warn('Onboarding flag read threw', err)
        }
      })
      .catch(() => {
        router.replace('/login?returnUrl=/onboarding')
      })
  }, [router, afterOnboarding])

  const fetchTraders = useCallback(async () => {
    setLoadingTraders(true)
    try {
      const res = await fetch('/api/sidebar/top-traders')
      const data = await res.json()
      setTraders(data.traders || [])
    } catch (err) {
      logger.error('Failed to fetch traders', err)
    } finally {
      setLoadingTraders(false)
    }
  }, [])

  const fetchGroups = useCallback(async () => {
    setLoadingGroups(true)
    try {
      const res = await fetch('/api/groups?limit=8&sort_by=member_count')
      const data = await res.json()
      const raw = data.data?.groups || data.data || data.groups || []
      setGroups(Array.isArray(raw) ? raw : [])
    } catch (err) {
      logger.error('Failed to fetch groups', err)
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
    trackEvent('onboarding_step_complete', {
      step,
      nextStep,
      interests: selectedInterests.length,
      followedTraders: followedTraders.size,
      joinedGroups: joinedGroups.size,
    })
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
        else if (step === 'complete') router.push(afterOnboarding)
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
    setSelectedInterests((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  }

  // Batch follow/join: queue actions and flush in parallel after a debounce
  const followQueueRef = useRef<
    Map<string, { traderId: string; source: string; action: 'follow' | 'unfollow' }>
  >(new Map())
  const joinQueueRef = useRef<Map<string, OnboardingMembershipIntent>>(new Map())
  const followFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const joinFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushFollowQueue = useCallback(async () => {
    const queue = new Map(followQueueRef.current)
    followQueueRef.current.clear()
    if (queue.size === 0) return
    // /api/follow is withAuth (Bearer header only) — calls 401'd without the token
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.access_token) return
    const promises = Array.from(queue.values()).map(({ traderId, source, action }) =>
      fetch('/api/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ traderId, source, action }),
      }).catch(() => {
        /* swallow individual failures; UI already updated optimistically */
      })
    )
    Promise.all(promises)
  }, [])

  const flushJoinQueue = useCallback(async () => {
    const queue = new Map(joinQueueRef.current)
    joinQueueRef.current.clear()
    if (queue.size === 0) return

    const failures = await Promise.all(
      Array.from(queue.values()).map((intent) =>
        membershipRequestSequencerRef.current.run(intent.groupId, async () => {
          if (
            !membershipIntentLedgerRef.current.belongsToScope(intent, membershipScopeRef.current)
          ) {
            return null
          }

          try {
            const {
              data: { session },
            } = await supabase.auth.getSession()

            if (
              !membershipIntentLedgerRef.current.belongsToScope(intent, membershipScopeRef.current)
            ) {
              return null
            }
            if (!session?.access_token || session.user.id !== intent.viewerId) {
              throw new Error('Onboarding membership session is unavailable or stale')
            }

            await sendOnboardingMembershipIntent(intent, session.access_token, getCsrfHeaders())
            return null
          } catch (error) {
            logger.error('Onboarding group membership request failed', {
              action: intent.action,
              error,
              groupId: intent.groupId,
            })

            if (!membershipIntentLedgerRef.current.isCurrent(intent, membershipScopeRef.current)) {
              return null
            }

            const next = rollbackOnboardingMembershipIntent(joinedGroupsRef.current, intent)
            joinedGroupsRef.current = next
            setJoinedGroups(next)
            return intent
          }
        })
      )
    )

    const currentScope = membershipScopeRef.current
    if (
      failures.some(
        (intent) =>
          intent !== null && membershipIntentLedgerRef.current.isCurrent(intent, currentScope)
      )
    ) {
      showToastRef.current(
        translations[languageRef.current].joinFailed || translations.en.joinFailed,
        'error'
      )
    }
  }, [])

  const settleMembershipIntents = useCallback(async () => {
    membershipSettlingRef.current = true
    if (joinFlushTimerRef.current) {
      clearTimeout(joinFlushTimerRef.current)
      joinFlushTimerRef.current = null
    }
    await flushJoinQueue()
    await membershipRequestSequencerRef.current.drain()
  }, [flushJoinQueue])

  const handleFollowTrader = async (traderId: string) => {
    if (!userId) {
      const { data } = await supabase.auth.getUser()
      if (data?.user?.id) setUserId(data.user.id)
      else return
    }
    const isFollowed = followedTraders.has(traderId)
    const next = new Set(followedTraders)
    if (isFollowed) next.delete(traderId)
    else next.add(traderId)
    setFollowedTraders(next)
    // Queue the action and debounce the flush
    const trader = traders.find(
      (candidate) => `${candidate.source}:${candidate.source_trader_id}` === traderId
    )
    if (!trader) return
    followQueueRef.current.set(traderId, {
      traderId: trader.source_trader_id,
      source: trader.source,
      action: isFollowed ? 'unfollow' : 'follow',
    })
    if (followFlushTimerRef.current) clearTimeout(followFlushTimerRef.current)
    followFlushTimerRef.current = setTimeout(flushFollowQueue, 500)
  }

  const handleJoinGroup = async (groupId: string) => {
    if (!userId || membershipSettlingRef.current) return
    const isJoined = joinedGroupsRef.current.has(groupId)
    const action = isJoined ? 'leave' : 'join'
    const intent = membershipIntentLedgerRef.current.issue(
      groupId,
      action,
      membershipScopeRef.current
    )
    if (!intent) return

    const next = new Set(joinedGroupsRef.current)
    if (isJoined) next.delete(groupId)
    else next.add(groupId)
    joinedGroupsRef.current = next
    setJoinedGroups(next)
    // Queue the action and debounce the flush
    joinQueueRef.current.set(groupId, intent)
    if (joinFlushTimerRef.current) clearTimeout(joinFlushTimerRef.current)
    joinFlushTimerRef.current = setTimeout(flushJoinQueue, 500)
  }

  // Follow requests retain their historical fire-and-forget behavior. Group
  // intents are settled explicitly before completion; an unrelated unmount
  // invalidates and drops work that has not started instead of publishing UI
  // reconciliation after ownership is gone.
  useEffect(() => {
    const pendingJoinQueue = joinQueueRef.current
    return () => {
      if (followFlushTimerRef.current) clearTimeout(followFlushTimerRef.current)
      if (joinFlushTimerRef.current) clearTimeout(joinFlushTimerRef.current)
      flushFollowQueue()
      pendingJoinQueue.clear()
    }
  }, [flushFollowQueue])

  const saveAndComplete = async () => {
    setSaving(true)
    try {
      await settleMembershipIntents()
      if (userId) {
        const updates: Record<string, unknown> = { onboarding_completed: true }
        if (selectedInterests.length > 0) updates.interests = selectedInterests
        const { error } = await supabase.from('user_profiles').update(updates).eq('id', userId)
        if (error) logger.error('Error saving onboarding:', error)
      }
      localStorage.setItem('hasOnboarded', 'true')
      trackEvent('onboarding_complete', {
        interests: selectedInterests.length,
        followedTraders: followedTraders.size,
        joinedGroups: joinedGroupsRef.current.size,
      })
      setStep('complete')
    } catch (err) {
      membershipSettlingRef.current = false
      logger.error('Error completing onboarding:', err)
      showToast(tr('saveFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  // Skip the activation flow: mark onboarding complete (so it never reappears)
  // and exit to the returnUrl. Routing always proceeds even if the DB write fails.
  const handleSkip = async () => {
    if (saving) return
    setSaving(true)
    trackEvent('onboarding_skip', { step })
    try {
      if (userId) {
        const { error } = await supabase
          .from('user_profiles')
          .update({ onboarding_completed: true })
          .eq('id', userId)
        if (error) logger.error('Error skipping onboarding:', error)
      }
      try {
        localStorage.setItem('hasOnboarded', 'true')
      } catch {
        /* localStorage may be unavailable */
      }
    } finally {
      router.replace(afterOnboarding)
    }
  }

  if (!mounted) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            border: '3px solid var(--color-accent-primary-20)',
            borderTopColor: 'var(--color-brand)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
      </Box>
    )
  }

  const isDark = theme === 'dark'
  const obTheme: OnboardingTheme = {
    isDark,
    // 2026-07-04 修 U4:暗色分支曾用 --color-backdrop-heavy(黑遮罩)当卡面;
    // 统一用主题感知的 --glass-bg-heavy(暗色=半透白玻璃,亮色=近白),两色都可读。
    cardBg: 'var(--glass-bg-heavy)',
    cardBorder: isDark ? 'var(--color-accent-primary-15)' : 'var(--color-accent-primary-20)',
    textPrimary: 'var(--color-text-primary)',
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
    <Box
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div className={`onboarding-bg ${theme}`} />

      <Box
        className="onboarding-card"
        style={{
          maxWidth: 560,
          width: '100%',
          background: obTheme.cardBg,
          border: `1px solid ${obTheme.cardBorder}`,
          borderRadius: 28,
          padding: 'clamp(24px, 5vw, 44px) clamp(20px, 4vw, 36px)',
          position: 'relative',
          zIndex: 1,
          boxShadow: isDark
            ? '0 25px 50px -12px var(--color-overlay-dark), 0 0 100px var(--color-notification-unread)'
            : '0 25px 50px -12px var(--color-overlay-subtle), 0 0 100px var(--color-accent-primary-10)',
        }}
      >
        {/* Skip for now — available on every step before completion */}
        {step !== 'complete' && (
          <button
            type="button"
            onClick={handleSkip}
            disabled={saving}
            className="onboarding-skip-btn"
            style={{
              position: 'absolute',
              top: 16,
              right: 18,
              background: 'transparent',
              border: 'none',
              color: obTheme.textSecondary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.medium,
              cursor: saving ? 'wait' : 'pointer',
              padding: '6px 10px',
              borderRadius: tokens.radius.md,
              opacity: saving ? 0.6 : 1,
              zIndex: 2,
            }}
          >
            {tr('skip')}
          </button>
        )}

        {/* Progress bar - hidden on complete step */}
        <Box
          style={{
            display: step === 'complete' ? 'none' : 'flex',
            justifyContent: 'center',
            gap: 10,
            marginBottom: 36,
          }}
        >
          {STEPS.map((s, i) => (
            <Box
              key={s}
              className={`progress-dot ${stepIndex === i ? 'active' : ''}`}
              style={{
                width: stepIndex === i ? 28 : 10,
                height: 10,
                borderRadius: 5,
                background:
                  i <= stepIndex
                    ? obTheme.brandGradient
                    : isDark
                      ? 'var(--glass-border-light)'
                      : 'var(--color-overlay-subtle)',
                transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            />
          ))}
        </Box>

        {step === 'welcome' && (
          <WelcomeStep
            theme={obTheme}
            language={language}
            currentTheme={theme}
            tr={tr}
            onLanguageChange={handleLanguageChange}
            onThemeChange={handleThemeChange}
            onContinue={() => goToStep('interests')}
          />
        )}
        {step === 'interests' && (
          <InterestsStep
            theme={obTheme}
            selectedInterests={selectedInterests}
            tr={tr}
            onToggleInterest={toggleInterest}
            onBack={() => goToStep('welcome')}
            onContinue={() => goToStep('traders')}
          />
        )}
        {step === 'traders' && (
          <TradersStep
            theme={obTheme}
            language={language}
            traders={traders}
            followedTraders={followedTraders}
            loadingTraders={loadingTraders}
            tr={tr}
            onFollowTrader={handleFollowTrader}
            onBack={() => goToStep('interests')}
            onContinue={() => goToStep('groups')}
          />
        )}
        {step === 'groups' && (
          <GroupsStep
            theme={obTheme}
            language={language}
            groups={groups}
            joinedGroups={joinedGroups}
            loadingGroups={loadingGroups}
            saving={saving}
            tr={tr}
            onJoinGroup={handleJoinGroup}
            onBack={() => goToStep('traders')}
            onComplete={saveAndComplete}
          />
        )}
        {step === 'complete' && (
          <CompleteStep theme={obTheme} tr={tr} onGoRankings={() => router.push(afterOnboarding)} />
        )}
      </Box>
    </Box>
  )
}
