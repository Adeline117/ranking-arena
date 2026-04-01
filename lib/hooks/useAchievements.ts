'use client'

import { useCallback } from 'react'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  checkAndUnlock,
  getUnlockedAchievements,
  trackTraderView,
  type AchievementKey,
  type Achievement,
} from '@/lib/services/achievements'

const ACHIEVEMENT_ICONS: Record<string, string> = {
  star: '\u2B50',
  chart: '\uD83D\uDCC8',
  pen: '\u270D\uFE0F',
  compass: '\uD83E\uDDED',
  crown: '\uD83D\uDC51',
  users: '\uD83E\uDDD1\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1',
}

export function useAchievements() {
  const { showToast } = useToast()
  const { userId } = useAuthSession()
  const { language } = useLanguage()

  const showAchievementToast = useCallback((achievement: Achievement) => {
    const title = language === 'zh' ? achievement.titleZh : achievement.title
    const desc = language === 'zh' ? achievement.descriptionZh : achievement.description
    const icon = ACHIEVEMENT_ICONS[achievement.icon] || ''
    const prefix = language === 'zh' ? '成就解锁' : 'Achievement Unlocked'
    showToast(`${icon} ${prefix}: ${title} — ${desc}`, 'success', 6000)
  }, [showToast, language])

  const tryUnlock = useCallback((key: AchievementKey) => {
    if (!userId) return
    const achievement = checkAndUnlock(userId, key)
    if (achievement) {
      showAchievementToast(achievement)
    }
  }, [userId, showAchievementToast])

  const tryTrackTraderView = useCallback((traderId: string) => {
    if (!userId) return
    const achievement = trackTraderView(userId, traderId)
    if (achievement) {
      showAchievementToast(achievement)
    }
  }, [userId, showAchievementToast])

  const getAll = useCallback(() => {
    if (!userId) return {}
    return getUnlockedAchievements(userId)
  }, [userId])

  return {
    tryUnlock,
    tryTrackTraderView,
    getUnlockedAchievements: getAll,
  }
}
