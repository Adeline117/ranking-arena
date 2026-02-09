'use client'

import { useEffect, useState, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

interface DayData {
  date: string
  count: number
}

interface Props {
  userId: string
}

const CELL_SIZE = 11
const CELL_GAP = 2
const TOTAL = CELL_SIZE + CELL_GAP

function getColorForCount(count: number): string {
  if (count === 0) return tokens.colors.border.primary
  if (count <= 2) return 'var(--color-heatmap-1)'
  if (count <= 5) return 'var(--color-heatmap-2)'
  if (count <= 10) return 'var(--color-heatmap-3)'
  return 'var(--color-heatmap-4)'
}

export default function ActivityHeatmap({ userId }: Props) {
  const { t } = useLanguage()
  const [dayMap, setDayMap] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    async function load() {
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - 364)
      const startStr = startDate.toISOString().slice(0, 10)

      const { data, error } = await supabase
        .from('user_activity')
        .select('created_at')
        .eq('user_id', userId)
        .gte('created_at', startStr + 'T00:00:00Z')
        .order('created_at', { ascending: true })

      if (error) {
        logger.error('[ActivityHeatmap]', error)
        setLoading(false)
        return
      }

      const map = new Map<string, number>()
      for (const row of data || []) {
        const day = new Date(row.created_at).toISOString().slice(0, 10)
        map.set(day, (map.get(day) || 0) + 1)
      }
      setDayMap(map)
      setLoading(false)
    }
    load()
  }, [userId])

  const weeks = useMemo(() => {
    const result: DayData[][] = []
    const today = new Date()
    const start = new Date()
    start.setDate(today.getDate() - 364)
    // 调整到周日开始
    start.setDate(start.getDate() - start.getDay())

    const current = new Date(start)
    let week: DayData[] = []

    while (current <= today) {
      const dateStr = current.toISOString().slice(0, 10)
      week.push({ date: dateStr, count: dayMap.get(dateStr) || 0 })
      if (week.length === 7) {
        result.push(week)
        week = []
      }
      current.setDate(current.getDate() + 1)
    }
    if (week.length > 0) result.push(week)
    return result
  }, [dayMap])

  const totalCount = useMemo(() => {
    let sum = 0
    dayMap.forEach((v) => (sum += v))
    return sum
  }, [dayMap])

  if (loading) {
    return (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {t('loading') || '加载中...'}
        </span>
      </div>
    )
  }

  const svgWidth = weeks.length * TOTAL + 30
  const svgHeight = 7 * TOTAL + 20

  const months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
          {t('activityOverview') || '活动概览'}
        </span>
        <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
          {t('totalActivities') || '共'} {totalCount} {t('activities') || '次活动'}
        </span>
      </div>
      <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
        <svg
          width={svgWidth}
          height={svgHeight}
          style={{ display: 'block' }}
        >
          {/* 月份标签 */}
          {weeks.map((week, wi) => {
            if (wi === 0) return null
            const prevMonth = new Date(weeks[wi - 1][0].date).getMonth()
            const curMonth = new Date(week[0].date).getMonth()
            if (curMonth !== prevMonth) {
              return (
                <text
                  key={`m-${wi}`}
                  x={wi * TOTAL}
                  y={10}
                  fontSize={10}
                  fill={tokens.colors.text.tertiary}
                >
                  {months[curMonth]}
                </text>
              )
            }
            return null
          })}

          {/* 格子 */}
          {weeks.map((week, wi) =>
            week.map((day, di) => (
              <rect
                key={day.date}
                x={wi * TOTAL}
                y={di * TOTAL + 16}
                width={CELL_SIZE}
                height={CELL_SIZE}
                rx={2}
                fill={getColorForCount(day.count)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const rect = (e.target as SVGRectElement).getBoundingClientRect()
                  setTooltip({
                    x: rect.left + rect.width / 2,
                    y: rect.top - 8,
                    text: `${day.date}: ${day.count} 次活动`,
                  })
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            ))
          )}
        </svg>
      </div>

      {/* 图例 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, justifyContent: 'flex-end' }}>
        <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginRight: 4 }}>
          {t('less') || '少'}
        </span>
        {[0, 2, 5, 10, 15].map((v) => (
          <div
            key={v}
            style={{
              width: CELL_SIZE,
              height: CELL_SIZE,
              borderRadius: 2,
              background: getColorForCount(v),
            }}
          />
        ))}
        <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginLeft: 4 }}>
          {t('more') || '多'}
        </span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)',
            background: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.sm,
            padding: '4px 8px',
            fontSize: 12,
            color: tokens.colors.text.primary,
            pointerEvents: 'none',
            zIndex: 9999,
            whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-sm-dark)',
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  )
}
