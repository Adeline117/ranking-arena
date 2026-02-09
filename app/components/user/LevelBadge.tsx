'use client'

import { getLevelInfo, LevelInfo } from '@/lib/utils/user-level'

interface LevelBadgeProps {
  exp: number
  isPro?: boolean
  size?: 'sm' | 'md' | 'lg'
  showName?: boolean
}

// SVG海洋生物图标
function LevelIcon({ level, color, size }: { level: number; color: string; size: number }) {
  const iconSize = size

  // Lv1 磷虾
  if (level === 1) {
    return (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
        <path
          d="M4 12c0-2 2-6 8-6s8 4 8 6-2 6-8 6-8-4-8-6z"
          fill={color}
          opacity={0.2}
        />
        <path
          d="M6 12c0-1.5 1.5-4 6-4s6 2.5 6 4-1.5 4-6 4-6-2.5-6-4z"
          stroke={color}
          strokeWidth={1.5}
          fill="none"
        />
        <circle cx={10} cy={11} r={1} fill={color} />
        <path d="M5 10l-2-2M5 14l-2 2" stroke={color} strokeWidth={1} />
      </svg>
    )
  }

  // Lv2 沙丁鱼
  if (level === 2) {
    return (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
        <path
          d="M3 12c2-4 6-5 10-5 3 0 5 1 8 5-3 4-5 5-8 5-4 0-8-1-10-5z"
          fill={color}
          opacity={0.2}
          stroke={color}
          strokeWidth={1.5}
        />
        <path d="M19 7l2-2M19 17l2 2" stroke={color} strokeWidth={1.5} />
        <circle cx={8} cy={11.5} r={1.2} fill={color} />
      </svg>
    )
  }

  // Lv3 海豚
  if (level === 3) {
    return (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
        <path
          d="M3 14c1-5 4-8 9-8 2 0 4 1 6 3l3-2v4c0 3-2 6-6 7-2 0.5-4 0-6-1-3-1.5-5-3-6-3z"
          fill={color}
          opacity={0.2}
          stroke={color}
          strokeWidth={1.5}
        />
        <circle cx={8} cy={11} r={1} fill={color} />
        <path d="M12 6c1-3 3-4 5-3" stroke={color} strokeWidth={1.2} fill="none" />
      </svg>
    )
  }

  // Lv4 鲨鱼
  if (level === 4) {
    return (
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
        <path
          d="M2 13c1-4 4-7 10-7 4 0 7 2 10 7-3 4-6 6-10 6-6 0-9-2-10-6z"
          fill={color}
          opacity={0.2}
          stroke={color}
          strokeWidth={1.5}
        />
        <path d="M12 6l-1-4 3 3" fill={color} />
        <circle cx={7} cy={12} r={1.2} fill={color} />
        <path d="M20 13l3 0" stroke={color} strokeWidth={1.5} />
      </svg>
    )
  }

  // Lv5 虎鲸
  return (
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
      <path
        d="M2 13c1-5 5-8 10-8 4 0 7 2 10 8-3 4-6 6-10 6-5 0-9-3-10-6z"
        fill={color}
        opacity={0.25}
        stroke={color}
        strokeWidth={1.5}
      />
      <path d="M12 5l-2-4 1 3M14 5l2-4-1 3" stroke={color} strokeWidth={1.2} />
      <ellipse cx={7} cy={11.5} rx={2} ry={1.5} fill={color} opacity={0.5} />
      <circle cx={7} cy={11.5} r={1} fill={color} />
      <path d="M20 13l3 1M20 12l3-1" stroke={color} strokeWidth={1.5} />
    </svg>
  )
}

const SIZES = {
  sm: { icon: 16, text: 'text-xs', gap: 'gap-0.5' },
  md: { icon: 20, text: 'text-sm', gap: 'gap-1' },
  lg: { icon: 24, text: 'text-base', gap: 'gap-1.5' },
}

export default function LevelBadge({ exp, isPro, size = 'sm', showName = false }: LevelBadgeProps) {
  const info = getLevelInfo(exp)
  const s = SIZES[size]

  return (
    <span className={`inline-flex items-center ${s.gap}`}>
      <LevelIcon level={info.level} color={info.colorHex} size={s.icon} />
      <span className={`${s.text} font-medium`} style={{ color: info.colorHex }}>
        Lv{info.level}
      </span>
      {showName && (
        <span className={`${s.text} opacity-70`} style={{ color: info.colorHex }}>
          {info.name}
        </span>
      )}
      {isPro && (
        <span
          className={`${s.text} font-bold px-1 rounded`}
          style={{ color: 'var(--color-accent-warning)', background: 'var(--color-orange-bg-light)' }}
        >
          PRO
        </span>
      )}
    </span>
  )
}
