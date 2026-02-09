'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import LevelBadge from '@/app/components/user/LevelBadge'
import { LEVELS, EXP_ACTIONS, getLevelInfo, type LevelInfo } from '@/lib/utils/user-level'

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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  const info = levelData || getLevelInfo(0)

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* 头部 */}
      <div className="bg-zinc-900 rounded-xl p-6 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-zinc-700 flex items-center justify-center text-2xl text-zinc-400">
            U
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl font-bold text-zinc-100">用户</span>
              <LevelBadge exp={info.currentExp} isPro={levelData?.isPro} size="md" showName />
            </div>
            {/* 进度条 */}
            <div className="w-full max-w-md">
              <div className="flex justify-between text-xs text-zinc-400 mb-1">
                <span>EXP {info.currentExp.toLocaleString()}</span>
                <span>{info.nextExp ? `下一级 ${info.nextExp.toLocaleString()}` : '已满级'}</span>
              </div>
              <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${info.progress}%`, backgroundColor: info.colorHex }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 数据面板 */}
        <div className="grid grid-cols-6 gap-4 mt-6 pt-4 border-t border-zinc-800">
          {[
            { label: '动态', value: stats.posts },
            { label: '粉丝', value: stats.followers },
            { label: '关注', value: stats.following },
            { label: '收藏', value: stats.bookmarks },
            { label: '获赞', value: stats.likes },
            { label: '阅读', value: stats.reads },
          ].map((item) => (
            <div key={item.label} className="text-center">
              <div className="text-lg font-bold text-zinc-100">{item.value}</div>
              <div className="text-xs text-zinc-500">{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab切换 */}
      <div className="flex gap-1 mb-6 bg-zinc-900 rounded-lg p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab内容 */}
      <div className="bg-zinc-900 rounded-xl p-6">
        {activeTab === 'level' && <LevelTab info={info} dailyEarned={levelData?.dailyExpEarned ?? 0} />}
        {activeTab === 'membership' && <MembershipTab isPro={levelData?.isPro} proExpiresAt={levelData?.proExpiresAt} />}
        {activeTab === 'badges' && <div className="text-zinc-400 text-center py-12">成就徽章功能即将上线</div>}
        {activeTab === 'bookmarks' && <div className="text-zinc-400 text-center py-12">收藏夹功能即将上线</div>}
        {activeTab === 'settings' && <div className="text-zinc-400 text-center py-12">设置页面即将上线</div>}
      </div>
    </div>
  )
}

function LevelTab({ info, dailyEarned }: { info: LevelInfo & { currentExp: number }; dailyEarned: number }) {
  return (
    <div className="space-y-6">
      {/* 当前等级信息 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-100 mb-4">当前等级</h3>
        <div className="flex items-center gap-4 p-4 bg-zinc-800 rounded-lg">
          <LevelBadge exp={info.currentExp} size="lg" showName />
          <div className="flex-1">
            <div className="text-sm text-zinc-400">
              经验值: {info.currentExp.toLocaleString()}
              {info.nextExp && ` / ${info.nextExp.toLocaleString()}`}
            </div>
            <div className="text-sm text-zinc-500 mt-1">
              今日已获得: +{dailyEarned} EXP
            </div>
          </div>
        </div>
      </div>

      {/* EXP获取途径 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-100 mb-4">经验获取途径</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {EXP_ACTIONS.map((action) => (
            <div key={action.key} className="flex justify-between items-center p-3 bg-zinc-800 rounded-lg">
              <span className="text-sm text-zinc-300">{action.label}</span>
              <span className="text-sm">
                <span className="text-green-400">+{action.exp}</span>
                {action.dailyLimit !== null && (
                  <span className="text-zinc-500 ml-1">({action.dailyLimit}/天)</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 等级对比 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-100 mb-4">等级一览</h3>
        <div className="space-y-2">
          {LEVELS.map((lvl) => (
            <div
              key={lvl.level}
              className={`flex items-center justify-between p-3 rounded-lg ${
                info.level === lvl.level ? 'bg-zinc-800 ring-1' : 'bg-zinc-800/50'
              }`}
              style={info.level === lvl.level ? { borderColor: lvl.colorHex } : {}}
            >
              <div className="flex items-center gap-3">
                <span className="font-bold" style={{ color: lvl.colorHex }}>
                  Lv{lvl.level}
                </span>
                <span className="text-zinc-300">{lvl.name}</span>
                <span className="text-zinc-500 text-sm">{lvl.nameEn}</span>
              </div>
              <span className="text-sm text-zinc-400">{lvl.minExp.toLocaleString()} EXP</span>
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
      <div className="p-6 bg-zinc-800 rounded-lg">
        <h3 className="text-lg font-bold text-zinc-100 mb-2">Pro 会员状态</h3>
        {isPro ? (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 rounded text-sm font-bold" style={{ color: '#EAB308', background: 'rgba(234,179,8,0.1)' }}>
                PRO
              </span>
              <span className="text-green-400 text-sm">已激活</span>
            </div>
            {proExpiresAt && (
              <p className="text-sm text-zinc-400">
                到期时间: {new Date(proExpiresAt).toLocaleDateString('zh-CN')}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="text-zinc-400 mb-4">升级Pro会员，解锁更多特权</p>
            <button className="px-6 py-2 bg-yellow-500 text-black font-bold rounded-lg hover:bg-yellow-400 transition-colors">
              升级 Pro
            </button>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-lg font-bold text-zinc-100 mb-4">Pro 特权</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            '每日额外 +50 EXP',
            '专属金色标识',
            '高级数据分析',
            '优先客服支持',
            '专属Pro小组',
            '去广告体验',
          ].map((perk) => (
            <div key={perk} className="flex items-center gap-2 p-3 bg-zinc-800 rounded-lg">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
              <span className="text-sm text-zinc-300">{perk}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
