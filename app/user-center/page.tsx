'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import LevelBadge from '@/app/components/user/LevelBadge'
import { LEVELS, EXP_ACTIONS, getLevelInfo, type LevelInfo } from '@/lib/utils/user-level'
import { tokens } from '@/lib/design-tokens'

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
  const [activeTab, setActiveTab] = useState<Tab>('level')
  const [levelData, setLevelData] = useState<UserLevelData | null>(null)
  const [stats, setStats] = useState<UserStats>({ posts: 0, followers: 0, following: 0, bookmarks: 0, likes: 0, reads: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
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
    fetchData()
  }, [])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'level', label: '我的等级' },
    { key: 'membership', label: '会员管理' },
    { key: 'badges', label: '成就徽章' },
    { key: 'bookmarks', label: '收藏夹' },
    { key: 'settings', label: '设置' },
  ]

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: tokens.colors.accent.brand }} />
      </div>
    )
  }

  const info = levelData || getLevelInfo(0)

  return (
    <>
    <TopNav email={null} />
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
            U
          </div>
          <div className="flex-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2 mb-2">
              <span className="text-xl font-bold" style={{ color: tokens.colors.text.primary }}>用户</span>
              <LevelBadge exp={info.currentExp} isPro={levelData?.isPro} size="md" showName />
            </div>
            <div className="w-full max-w-md">
              <div className="flex justify-between text-xs mb-1" style={{ color: tokens.colors.text.tertiary }}>
                <span>EXP {info.currentExp.toLocaleString()}</span>
                <span>{info.nextExp ? `下一级 ${info.nextExp.toLocaleString()}` : '已满级'}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: tokens.colors.bg.tertiary }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${info.progress}%`, backgroundColor: info.colorHex }}
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
            { label: '动态', value: stats.posts },
            { label: '粉丝', value: stats.followers },
            { label: '关注', value: stats.following },
            { label: '收藏', value: stats.bookmarks },
            { label: '获赞', value: stats.likes },
            { label: '阅读', value: stats.reads },
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
        {activeTab === 'level' && <LevelTab info={info} dailyEarned={levelData?.dailyExpEarned ?? 0} />}
        {activeTab === 'membership' && <MembershipTab isPro={levelData?.isPro} proExpiresAt={levelData?.proExpiresAt} />}
        {activeTab === 'badges' && <div className="text-center py-12" style={{ color: tokens.colors.text.tertiary }}>成就徽章功能即将上线</div>}
        {activeTab === 'bookmarks' && <div className="text-center py-12" style={{ color: tokens.colors.text.tertiary }}>收藏夹功能即将上线</div>}
        {activeTab === 'settings' && <div className="text-center py-12" style={{ color: tokens.colors.text.tertiary }}>设置页面即将上线</div>}
      </div>
    </div>
    <MobileBottomNav />
    </>
  )
}

function LevelTab({ info, dailyEarned }: { info: LevelInfo & { currentExp: number }; dailyEarned: number }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold mb-4" style={{ color: tokens.colors.text.primary }}>当前等级</h3>
        <div className="flex items-center gap-4 p-4 rounded-lg" style={{ background: tokens.colors.bg.tertiary }}>
          <LevelBadge exp={info.currentExp} size="lg" showName />
          <div className="flex-1">
            <div className="text-sm" style={{ color: tokens.colors.text.tertiary }}>
              经验值: {info.currentExp.toLocaleString()}
              {info.nextExp && ` / ${info.nextExp.toLocaleString()}`}
            </div>
            <div className="text-sm mt-1" style={{ color: tokens.colors.text.tertiary }}>
              今日已获得: +{dailyEarned} EXP
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-bold mb-4" style={{ color: tokens.colors.text.primary }}>经验获取途径</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {EXP_ACTIONS.map((action) => (
            <div key={action.key} className="flex justify-between items-center p-3 rounded-lg" style={{ background: tokens.colors.bg.tertiary }}>
              <span className="text-sm" style={{ color: tokens.colors.text.secondary }}>
                {action.label}
              </span>
              <span className="text-sm">
                <span style={{ color: tokens.colors.accent.success }}>+{action.exp}</span>
                {action.dailyLimit !== null && (
                  <span style={{ color: tokens.colors.text.tertiary }} className="ml-1">({action.dailyLimit}/天)</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-bold mb-4" style={{ color: tokens.colors.text.primary }}>等级一览</h3>
        <div className="space-y-2">
          {LEVELS.map((lvl) => (
            <div
              key={lvl.level}
              className="flex items-center justify-between p-3 rounded-lg"
              style={{
                background: info.level === lvl.level ? tokens.colors.bg.tertiary : tokens.colors.bg.hover,
                ...(info.level === lvl.level ? { boxShadow: `inset 0 0 0 1px ${lvl.colorHex}` } : {}),
              }}
            >
              <div className="flex items-center gap-3">
                <span className="font-bold" style={{ color: lvl.colorHex }}>
                  Lv{lvl.level}
                </span>
                <span style={{ color: tokens.colors.text.secondary }}>{lvl.name}</span>
                <span className="text-sm" style={{ color: tokens.colors.text.tertiary }}>{lvl.nameEn}</span>
              </div>
              <span className="text-sm" style={{ color: tokens.colors.text.tertiary }}>{lvl.minExp.toLocaleString()} EXP</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MembershipTab({ isPro, proExpiresAt }: { isPro?: boolean; proExpiresAt?: string | null }) {
  return (
    <div className="space-y-6">
      <div className="p-6 rounded-lg" style={{ background: tokens.colors.bg.tertiary }}>
        <h3 className="text-lg font-bold mb-2" style={{ color: tokens.colors.text.primary }}>Pro 会员状态</h3>
        {isPro ? (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 rounded text-sm font-bold" style={{ color: 'var(--color-accent-warning)', background: 'var(--color-accent-primary-08)' }}>
                PRO
              </span>
              <span className="text-sm" style={{ color: tokens.colors.accent.success }}>已激活</span>
            </div>
            {proExpiresAt && (
              <p className="text-sm" style={{ color: tokens.colors.text.tertiary }}>
                到期时间: {new Date(proExpiresAt).toLocaleDateString('zh-CN')}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="mb-4" style={{ color: tokens.colors.text.tertiary }}>升级Pro会员，解锁更多特权</p>
            <button
              className="px-6 py-2 font-bold rounded-lg transition-colors"
              style={{ background: 'var(--color-accent-warning)', color: tokens.colors.black }}
            >
              升级 Pro
            </button>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-lg font-bold mb-4" style={{ color: tokens.colors.text.primary }}>Pro 特权</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            '每日额外 +50 EXP',
            '专属金色标识',
            '高级数据分析',
            '优先客服支持',
            '专属Pro小组',
            '去广告体验',
          ].map((perk) => (
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
