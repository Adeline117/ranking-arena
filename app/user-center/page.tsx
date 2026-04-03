'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import LevelBadge from '@/app/components/user/LevelBadge'
import { EXP_ACTIONS, getLevelInfo, type LevelInfo } from '@/lib/utils/user-level'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text, Button } from '@/app/components/base'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import MembershipContent from './MembershipContent'
import LevelTab from './components/LevelTab'

type Tab = 'level' | 'membership'

const VALID_TABS: Tab[] = ['level', 'membership']

interface UserLevelData extends LevelInfo {
  dailyExpEarned: number
  dailyExpDate: string
  isPro: boolean
  proExpiresAt: string | null
}

export default function UserCenterPageWrapper() {
  return (
    <Suspense fallback={<UserCenterSkeleton />}>
      <UserCenterPage />
    </Suspense>
  )
}

function UserCenterSkeleton() {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav email={null} />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Box style={{
          borderRadius: tokens.radius['2xl'],
          background: tokens.glass.bg.secondary,
          backdropFilter: tokens.glass.blur.md,
          WebkitBackdropFilter: tokens.glass.blur.md,
          border: tokens.glass.border.light,
          padding: tokens.spacing[6],
          marginBottom: tokens.spacing[5],
        }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
            <Box style={{ width: 56, height: 56, borderRadius: tokens.radius.full, background: tokens.colors.bg.tertiary, animation: 'pulse 1.5s ease-in-out infinite' }} />
            <Box style={{ flex: 1 }}>
              <Box style={{ width: 120, height: 20, borderRadius: tokens.radius.md, background: tokens.colors.bg.tertiary, animation: 'pulse 1.5s ease-in-out infinite', marginBottom: tokens.spacing[3] }} />
              <Box style={{ width: '100%', height: 8, borderRadius: tokens.radius.full, background: tokens.colors.bg.tertiary, animation: 'pulse 1.5s ease-in-out infinite' }} />
            </Box>
          </Box>
        </Box>
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[5] }}>
          {[1, 2].map(i => (
            <Box key={i} style={{ width: 100, height: 44, borderRadius: tokens.radius.lg, background: tokens.colors.bg.tertiary, animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </Box>
        {[1, 2, 3].map(i => (
          <Box key={i} style={{ height: 80, borderRadius: tokens.radius.xl, background: tokens.colors.bg.tertiary, animation: 'pulse 1.5s ease-in-out infinite', marginBottom: tokens.spacing[4] }} />
        ))}
        <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
      </Box>
    </Box>
  )
}

function UserCenterPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useLanguage()

  const tabFromUrl = searchParams.get('tab') as Tab | null
  const initialTab: Tab = tabFromUrl && VALID_TABS.includes(tabFromUrl) ? tabFromUrl : 'level'
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)
  const [levelData, setLevelData] = useState<UserLevelData | null>(null)
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [userHandle, setUserHandle] = useState<string | null>(null)
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    const tabParam = searchParams.get('tab') as Tab | null
    if (tabParam && VALID_TABS.includes(tabParam)) {
      setActiveTab(tabParam)
    }
  }, [searchParams])

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', tab)
    router.replace(url.pathname + url.search, { scroll: false })
  }

  useEffect(() => {
    async function init() {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setLoading(false)
          return
        }
        setUserId(user.id)
        setEmail(user.email ?? null)

        // Fetch profile + exp in parallel (reduced from 5 separate queries)
        const [profileResult, expResult] = await Promise.all([
          supabase
            .from('user_profiles')
            .select('handle, avatar_url')
            .eq('id', user.id)
            .maybeSingle(),
          fetch('/api/user/exp'),
        ])

        if (profileResult.data) {
          setUserHandle(profileResult.data.handle)
          setUserAvatarUrl(profileResult.data.avatar_url || null)
        }

        if (expResult.ok) {
          const json = await expResult.json()
          setLevelData(json.data)
        }
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'level', label: t('userCenterMyLevel') },
    { key: 'membership', label: t('userCenterMembership') },
  ]

  if (!loading && !userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav email={null} />
        <Box style={{
          maxWidth: 400, margin: '0 auto', padding: tokens.spacing[8],
          textAlign: 'center', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: tokens.spacing[4],
        }}>
          <Box style={{
            width: 64, height: 64, borderRadius: tokens.radius.full,
            background: `${tokens.colors.accent.primary}15`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: tokens.spacing[2],
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </Box>
          <Text size="xl" weight="bold">{t('userCenterLoginRequired')}</Text>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
            {t('userCenterLoginDescription')}
          </Text>
          <Button variant="primary" onClick={() => router.push('/login?redirect=/user-center')} style={{ marginTop: tokens.spacing[2] }}>
            {t('userCenterSignIn')}
          </Button>
        </Box>
      </Box>
    )
  }

  if (loading) {
    return <UserCenterSkeleton />
  }

  const info = levelData || getLevelInfo(0)

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 800, margin: '0 auto', paddingLeft: tokens.spacing[6], paddingRight: tokens.spacing[6] }}>
        <Breadcrumb items={[{ label: t('userCenter') || 'User Center' }]} />
      </Box>

      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], paddingTop: 0, paddingBottom: 100 }}>
        {/* Header Card */}
        <Box style={{
          borderRadius: tokens.radius['2xl'], padding: tokens.spacing[6], marginBottom: tokens.spacing[5],
          background: tokens.glass.bg.secondary, backdropFilter: tokens.glass.blur.md,
          WebkitBackdropFilter: tokens.glass.blur.md, border: tokens.glass.border.light, boxShadow: tokens.shadow.md,
        }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
            <Box style={{
              width: 56, height: 56, borderRadius: tokens.radius.full,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: tokens.typography.fontSize['2xl'], fontWeight: tokens.typography.fontWeight.black,
              background: tokens.glass.bg.light, backdropFilter: tokens.glass.blur.xs,
              WebkitBackdropFilter: tokens.glass.blur.xs, border: tokens.glass.border.light,
              color: tokens.colors.text.tertiary, flexShrink: 0,
              overflow: 'hidden', position: 'relative',
            }}>
              {(userHandle || 'U').charAt(0).toUpperCase()}
              {userAvatarUrl && (
                <Image
                  src={`/api/avatar?url=${encodeURIComponent(userAvatarUrl)}`}
                  alt={userHandle || 'User'}
                  width={56}
                  height={56}
                  unoptimized
                  style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
              )}
            </Box>

            <Box style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3], flexWrap: 'wrap' }}>
                <Text size="lg" weight="black" style={{ letterSpacing: '-0.2px' }}>
                  {userHandle || t('userCenterDefaultUser')}
                </Text>
                <LevelBadge exp={info.currentExp} isPro={levelData?.isPro} size="md" showName />
              </Box>

              <Box style={{ width: '100%' }}>
                <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[1] }}>
                  <Text size="xs" color="tertiary">EXP {info.currentExp.toLocaleString()}</Text>
                  <Text size="xs" color="tertiary">
                    {info.nextExp ? `${t('userCenterNextLevel')} ${info.nextExp.toLocaleString()}` : t('userCenterMaxLevel')}
                  </Text>
                </Box>
                <Box style={{ height: 6, borderRadius: tokens.radius.full, background: tokens.colors.bg.tertiary, overflow: 'hidden' }}>
                  <Box style={{
                    height: '100%', borderRadius: tokens.radius.full, width: `${info.progress}%`,
                    background: 'linear-gradient(90deg, var(--color-chart-violet), var(--color-brand), var(--color-accent-primary))',
                    transition: 'width 0.5s ease',
                  }} />
                </Box>
              </Box>
            </Box>
          </Box>
        </Box>

        {/* Tab Navigation */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[5] }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              style={{
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.xl,
                border: activeTab === tab.key ? `1px solid ${tokens.colors.accent.primary}60` : tokens.glass.border.light,
                background: activeTab === tab.key ? `${tokens.colors.accent.primary}15` : tokens.glass.bg.secondary,
                backdropFilter: tokens.glass.blur.xs, WebkitBackdropFilter: tokens.glass.blur.xs,
                color: activeTab === tab.key ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeTab === tab.key ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                cursor: 'pointer', transition: `all ${tokens.transition.base}`, minHeight: 44,
              }}
            >
              {tab.label}
            </button>
          ))}
        </Box>

        {/* Content */}
        <Box style={{
          borderRadius: tokens.radius['2xl'], padding: tokens.spacing[6],
          background: tokens.glass.bg.secondary, backdropFilter: tokens.glass.blur.md,
          WebkitBackdropFilter: tokens.glass.blur.md, border: tokens.glass.border.light, boxShadow: tokens.shadow.md,
        }}>
          {activeTab === 'level' && (
            <LevelTab info={info} dailyEarned={levelData?.dailyExpEarned ?? 0} expActions={EXP_ACTIONS} />
          )}
          {activeTab === 'membership' && <MembershipContent />}
        </Box>
      </Box>
    </Box>
  )
}
