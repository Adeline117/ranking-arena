'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface StreakData {
  current_streak: number
  longest_streak: number
  total_active_days: number
  last_active_date: string | null
}

interface Props {
  userId: string
}

export default function UserStreaks({ userId }: Props) {
  const { t } = useLanguage()
  const [data, setData] = useState<StreakData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: row, error } = await supabase
        .from('user_streaks')
        .select('current_streak, longest_streak, total_active_days, last_active_date')
        .eq('user_id', userId)
        .single()

      if (error || !row) {
        setData(null)
      } else {
        setData(row as StreakData)
      }
      setLoading(false)
    }
    load()
  }, [userId])

  if (loading) {
    return (
      <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {t('loading') || '加载中...'}
        </span>
      </div>
    )
  }

  const streak = data || { current_streak: 0, longest_streak: 0, total_active_days: 0 }

  const items = [
    {
      label: t('currentStreak') || '当前连续',
      value: streak.current_streak,
      suffix: t('days') || '天',
      color: streak.current_streak >= 7 ? 'var(--color-accent-success)' : tokens.colors.text.primary,
    },
    {
      label: t('longestStreak') || '最长连续',
      value: streak.longest_streak,
      suffix: t('days') || '天',
      color: tokens.colors.text.primary,
    },
    {
      label: t('totalActiveDays') || '总活跃天数',
      value: streak.total_active_days,
      suffix: t('days') || '天',
      color: tokens.colors.text.primary,
    },
  ]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: tokens.spacing[3],
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            padding: `${tokens.spacing[3]}px ${tokens.spacing[4]}px`,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: item.color,
              lineHeight: 1.2,
            }}
          >
            {item.value}
            <span style={{ fontSize: 12, fontWeight: 500, color: tokens.colors.text.tertiary, marginLeft: 2 }}>
              {item.suffix}
            </span>
          </div>
          <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginTop: 2 }}>
            {item.label}
          </div>
        </div>
      ))}
    </div>
  )
}
