
/**
 * ActivityIcon - renders a colored icon for each activity type.
 * Uses inline SVG paths from lucide to avoid runtime import overhead.
 */

import type { ActivityType } from '@/lib/types/activities'
import { ACTIVITY_META } from '@/lib/types/activities'

interface ActivityIconProps {
  type: ActivityType
  size?: number
}

/** Minimal SVG paths keyed by iconName (subset of lucide icons) */
const ICON_PATHS: Record<string, string> = {
  'trending-up': 'M22 7L13.5 15.5L8.5 10.5L2 17M22 7h-7M22 7v7',
  trophy: 'M8 21h8M12 17v4M5 3h14l-1 8a6 6 0 0 1-12 0L5 3z M3 7h18',
  'bar-chart': 'M12 20V10M18 20V4M6 20v-6',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  'dollar-sign': 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
}

export default function ActivityIcon({ type, size = 16 }: ActivityIconProps) {
  const meta = ACTIVITY_META[type]
  const path = ICON_PATHS[meta.iconName] ?? ICON_PATHS['bar-chart']

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={meta.colorVar}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}
