'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import LevelBadge from '@/app/components/user/LevelBadge'
import { LEVELS, EXP_ACTIONS, getLevelInfo, type LevelInfo } from '@/lib/utils/user-level'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text, Button } from '@/app/components/base'

type Tab = 'level' | 'membership' | 'badges' | 'bookmarks' | 'settings'

interface UserLevelData extends LevelInfo {
  dailyExpEarned: number
  dailyExpDate: string
  isPro: boolean
  proExpiresAt: string | null
}

interface UserStats {
  posts: number
  followers: number
  following: number
  bookmarks: number
  likes: number
  reads: number
}

export default function UserCenterPage() {
  const router = useRouter()
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [activeTab, setActiveTab] = useState<Tab>('level')
  const [levelData, setLevelData] = useState<UserLevelData | null>(null)
  const [stats, setStats] = useState<UserStats>({ posts: 0, followers: 0, following: 0, bookmarks: 0, likes: 0, reads: 0 })
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [userHandle, setUserHandle] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)

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

        // Fetch profile + stats
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('handle, follower_count, following_count')
          .eq('id', user.id)
          .maybeSingle()

        if (profile) {
          setUserHandle(profile.handle)
          setStats(prev => ({
            ...prev,
            followers: profile.follower_count ?? 0,
            following: profile.following_count ?? 0,
          }))
        }

        // Fetch exp data
        const res = await fetch('/api/user/exp')
        if (res.ok) {
          const json = await res.json()
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
    { key: 'level', label: isZh ? '我的等级' : 'My Level' },
    { key: 'membership', label: isZh ? '会员管理' : 'Membership' },
    { key: 'badges', label: isZh ? '成就徽章' : 'Badges' },
    { key: 'bookmarks', label: isZh ? '收藏夹' : 'Bookmarks' },
    { key: 'settings', label: isZh ? '设置' : 'Settings' },
  ]

  // Auth required screen
  if (!loading && !userId) {
    return (
      <>
        <TopNav email={null} />
        <Box style={{
          minHeight: '80vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: tokens.spacing[8],
        }}>
          <Box style={{
            maxWidth: 400,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: tokens.spacing[4],
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
            <Text size="xl" weight="bold">{isZh ? '请先登录' : 'Login Required'}</Text>
            <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
              {isZh ? '登录后可查看等级进度、管理会员和个人数据' : 'Sign in to view your level progress, manage membership and personal data'}
            </Text>
            <Button
              variant="primary"
              onClick={() => router.push('/login?redirect=/user-center')}
              style={{ marginTop: tokens.spacing[2] }}
            >
              {isZh ? '去登录' : 'Sign In'}
            </Button>
          </Box>
        </Box>
        <MobileBottomNav />
      </>
    )
  }

  if (loading) {
    return (
      <>
        <TopNav email={email} />
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: tokens.colors.accent.brand }} />
        </div>
        <MobileBottomNav />
      </>
    )
  }

  const info = levelData || getLevelInfo(0)

  return (
    <>
    <TopNav email={email} />
    <div className="max-w-4xl mx-auto px-4 sm:px-4 py-8" style={{ paddingBottom: 100 }}>
      {/* Header */}
      <div
        className="rounded-xl p-4 sm:p-6 mb-6"
        style={{ background: tokens.colors.bg.secondary }}
      >
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center text-2xl flex-shrink-0"
            style={{ background: tokens.colors.bg.tertiary, color: tokens.colors.text.tertiary }}
          >
            {(userHandle || 'U').charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2 mb-2">
              <span className="text-xl font-bold" style={{ color: tokens.colors.text.primary }}>
                {userHandle || (isZh ? '用户' : 'User')}
              </span>
              <LevelBadge exp={info.currentExp} isPro={levelData?.isPro} size="md" showName />
            </div>
            <div className="w-full max-w-md">
              <div className="flex justify-between text-xs mb-1" style={{ color: tokens.colors.text.tertiary }}>
                <span>EXP {info.currentExp.toLocaleString()}</span>
                <span>{info.nextExp ? `${isZh ? '下一级' : 'Next'} ${info.nextExp.toLocaleString()}` : (isZh ? '已满级' : 'Max Level')}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: tokens.colors.bg.tertiary }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${info.progress}%`, background: 'linear-gradient(90deg, var(--color-chart-violet), var(--color-brand), var(--color-accent-primary))' }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div
          className="grid grid-cols-3 sm:grid-cols-6 gap-3 sm:gap-4 mt-6 pt-4"
          style={{ borderTop: `1px solid ${tokens.colors.border.primary}` }}
        >
          {[
            { label: isZh ? '动态' : 'Posts', value: stats.posts },
            { label: isZh ? '粉丝' : 'Followers', value: stats.followers },
            { label: isZh ? '关注' : 'Following', value: stats.following },
            { label: isZh ? '收藏' : 'Bookmarks', value: stats.bookmarks },
            { label: isZh ? '获赞' : 'Likes', value: stats.likes },
            { label: isZh ? '阅读' : 'Reads', value: stats.reads },
          ].map((item) => (
            <div key={item.label} className="text-center">
              <div className="text-lg font-bold" style={{ color: tokens.colors.text.primary }}>{item.value}</div>
              <div className="text-xs" style={{ color: tokens.colors.text.tertiary }}>{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-1 mb-6 rounded-lg p-1 overflow-x-auto"
        style={{ background: tokens.colors.bg.secondary, scrollbarWidth: 'none' }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="flex-shrink-0 py-2.5 px-3 rounded-md text-sm font-medium transition-colors"
            style={{
              minHeight: 44,
              background: activeTab === tab.key ? tokens.colors.bg.tertiary : 'transparent',
              color: activeTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.tertiary,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="rounded-xl p-4 sm:p-6" style={{ background: tokens.colors.bg.secondary }}>
        {activeTab === 'level' && <LevelTab info={info} dailyEarned={levelData?.dailyExpEarned ?? 0} isZh={isZh} />}
        {activeTab === 'membership' && <MembershipTab isPro={levelData?.isPro} proExpiresAt={levelData?.proExpiresAt} isZh={isZh} />}
        {activeTab === 'badges' && <div className="text-center py-12" style={{ color: tokens.colors.text.tertiary }}>{isZh ? '成就徽章功能即将上线' : 'Achievement badges coming soon'}</div>}
        {activeTab === 'bookmarks' && <div className="text-center py-12" style={{ color: tokens.colors.text.tertiary }}>{isZh ? '收藏夹功能即将上线' : 'Bookmarks coming soon'}</div>}
        {activeTab === 'settings' && (
          <div className="text-center py-12">
            <p style={{ color: tokens.colors.text.tertiary, marginBottom: 16 }}>
              {isZh ? '前往设置页面管理您的账户' : 'Go to Settings to manage your account'}
            </p>
            <Button variant="primary" onClick={() => router.push('/settings')}>
              {isZh ? '打开设置' : 'Open Settings'}
            </Button>
          </div>
        )}
      </div>
    </div>
    <MobileBottomNav />
    </>
  )
}

function LevelTab({ info, dailyEarned, isZh }: { info: LevelInfo & { currentExp: number }; dailyEarned: number; isZh: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[8] }}>
      {/* Current Level Card */}
      <div>
        <h3 style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.bold,
          color: tokens.colors.text.primary,
          marginBottom: tokens.spacing[4],
        }}>
          {isZh ? '当前等级' : 'Current Level'}
        </h3>
        <div style={{
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          border: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[5] }}>
            <div style={{
              flexShrink: 0,
              width: 64,
              height: 64,
              borderRadius: tokens.radius.xl,
              background: `linear-gradient(135deg, ${info.colorHex}22, ${info.colorHex}44)`,
              border: `2px solid ${info.colorHex}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <LevelBadge exp={info.currentExp} size="lg" showName={false} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.spacing[2], marginBottom: tokens.spacing[1], flexWrap: 'wrap' }}>
                <span style={{ fontSize: tokens.typography.fontSize.xl, fontWeight: tokens.typography.fontWeight.bold, color: info.colorHex }}>
                  Lv{info.level} {info.name}
                </span>
                <span style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
                  {info.nameEn}
                </span>
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary,
                marginBottom: tokens.spacing[2],
              }}>
                <span>EXP {info.currentExp.toLocaleString()}{info.nextExp ? ` / ${info.nextExp.toLocaleString()}` : ''}</span>
                <span style={{ color: tokens.colors.accent.success, fontWeight: tokens.typography.fontWeight.semibold }}>
                  +{dailyEarned} {isZh ? '今日' : 'today'}
                </span>
              </div>
              {/* Gradient progress bar */}
              <div style={{
                height: 8,
                borderRadius: tokens.radius.full,
                background: tokens.colors.bg.hover,
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  borderRadius: tokens.radius.full,
                  width: `${info.progress}%`,
                  background: 'linear-gradient(90deg, var(--color-chart-violet), var(--color-brand), var(--color-accent-primary))',
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Ways to Earn EXP */}
      <div>
        <h3 style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.bold,
          color: tokens.colors.text.primary,
          marginBottom: tokens.spacing[4],
        }}>
          {isZh ? '经验获取途径' : 'Ways to Earn EXP'}
        </h3>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: tokens.spacing[3],
        }}>
          {EXP_ACTIONS.map((action) => (
            <div key={action.key} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}>
              <span style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary }}>
                {action.label}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
                <span style={{
                  display: 'inline-block',
                  padding: `2px ${tokens.spacing[2]}`,
                  borderRadius: tokens.radius.full,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.bold,
                  background: 'var(--color-accent-success)',
                  color: '#fff',
                }}>
                  +{action.exp}
                </span>
                {action.dailyLimit !== null && (
                  <span style={{
                    display: 'inline-block',
                    padding: `2px ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.full,
                    fontSize: tokens.typography.fontSize.xs,
                    background: tokens.colors.bg.hover,
                    color: tokens.colors.text.tertiary,
                  }}>
                    {action.dailyLimit}/{isZh ? '天' : 'd'}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Level Overview */}
      <div>
        <h3 style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.bold,
          color: tokens.colors.text.primary,
          marginBottom: tokens.spacing[4],
        }}>
          {isZh ? '等级一览' : 'Level Overview'}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {LEVELS.map((lvl) => {
            const isCurrent = info.level === lvl.level
            return (
              <div
                key={lvl.level}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                  borderRadius: tokens.radius.lg,
                  background: isCurrent
                    ? `linear-gradient(135deg, ${lvl.colorHex}18, ${lvl.colorHex}08)`
                    : tokens.colors.bg.tertiary,
                  border: isCurrent
                    ? `1.5px solid ${lvl.colorHex}`
                    : `1px solid ${tokens.colors.border.primary}`,
                  transition: 'all 0.2s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], minWidth: 0 }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 36,
                    height: 36,
                    borderRadius: tokens.radius.md,
                    background: `${lvl.colorHex}20`,
                    color: lvl.colorHex,
                    fontWeight: tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                    flexShrink: 0,
                  }}>
                    {lvl.level}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                      <span style={{
                        fontWeight: tokens.typography.fontWeight.semibold,
                        color: isCurrent ? lvl.colorHex : tokens.colors.text.primary,
                      }}>
                        {lvl.name}
                      </span>
                      <span style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                        {lvl.nameEn}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
                  {isCurrent && (
                    <span style={{
                      padding: `2px ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.full,
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.bold,
                      background: lvl.colorHex,
                      color: '#fff',
                    }}>
                      {isZh ? '当前' : 'Current'}
                    </span>
                  )}
                  <span style={{
                    fontSize: tokens.typography.fontSize.sm,
                    color: tokens.colors.text.tertiary,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {lvl.minExp.toLocaleString()} EXP
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function MembershipTab({ isPro, proExpiresAt, isZh }: { isPro?: boolean; proExpiresAt?: string | null; isZh: boolean }) {
  const router = useRouter()

  return (
    <div className="space-y-6">
      <div className="p-6 rounded-lg" style={{ background: tokens.colors.bg.tertiary }}>
        <h3 className="text-lg font-bold mb-2" style={{ color: tokens.colors.text.primary }}>
          {isZh ? 'Pro 会员状态' : 'Pro Membership Status'}
        </h3>
        {isPro ? (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 rounded text-sm font-bold" style={{ color: 'var(--color-accent-warning)', background: 'var(--color-accent-primary-08)' }}>
                PRO
              </span>
              <span className="text-sm" style={{ color: tokens.colors.accent.success }}>
                {isZh ? '已激活' : 'Active'}
              </span>
            </div>
            {proExpiresAt && (
              <p className="text-sm" style={{ color: tokens.colors.text.tertiary }}>
                {isZh ? '到期时间' : 'Expires'}: {new Date(proExpiresAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US')}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="mb-4" style={{ color: tokens.colors.text.tertiary }}>
              {isZh ? '升级Pro会员，解锁更多特权' : 'Upgrade to Pro to unlock more features'}
            </p>
            <button
              onClick={() => router.push('/pricing')}
              className="px-6 py-2 font-bold rounded-lg transition-colors"
              style={{ background: 'var(--color-accent-warning)', color: tokens.colors.black }}
            >
              {isZh ? '升级 Pro' : 'Upgrade Pro'}
            </button>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-lg font-bold mb-4" style={{ color: tokens.colors.text.primary }}>
          {isZh ? 'Pro 特权' : 'Pro Benefits'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(isZh ? [
            '每日额外 +50 EXP',
            '专属金色标识',
            '高级数据分析',
            '优先客服支持',
            '专属Pro小组',
            '去广告体验',
          ] : [
            'Extra +50 EXP daily',
            'Exclusive gold badge',
            'Advanced data analytics',
            'Priority support',
            'Exclusive Pro group',
            'Ad-free experience',
          ]).map((perk) => (
            <div key={perk} className="flex items-center gap-2 p-3 rounded-lg" style={{ background: tokens.colors.bg.tertiary }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-accent-warning)' }} />
              <span className="text-sm" style={{ color: tokens.colors.text.secondary }}>{perk}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
