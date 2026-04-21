'use client'

/**
 * SVG icons for quiz personality types (no emoji).
 */

interface QuizIconProps {
  name: string
  color: string
  size?: number
}

export function QuizIcon({ name, color, size = 24 }: QuizIconProps) {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }

  switch (name) {
    case 'crosshair':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="2" x2="12" y2="6" />
          <line x1="12" y1="18" x2="12" y2="22" />
          <line x1="2" y1="12" x2="6" y2="12" />
          <line x1="18" y1="12" x2="22" y2="12" />
        </svg>
      )
    case 'bolt':
      return (
        <svg {...props}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill={`${color}30`} />
        </svg>
      )
    case 'wave':
      return (
        <svg {...props}>
          <path d="M2 12C2 12 5 6 8 6C11 6 11 18 14 18C17 18 20 12 22 12" />
          <path d="M2 18C2 18 5 12 8 12C11 12 11 20 14 20" opacity="0.5" />
        </svg>
      )
    case 'chart':
      return (
        <svg {...props}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" opacity="0.3" />
        </svg>
      )
    case 'reverse':
      return (
        <svg {...props}>
          <polyline points="1 4 1 10 7 10" />
          <polyline points="23 20 23 14 17 14" />
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10" />
          <path d="M3.51 15A9 9 0 0 0 18.36 18.36L23 14" />
        </svg>
      )
    case 'diamond':
      return (
        <svg {...props}>
          <path d="M6 3L12 21L18 3" />
          <path d="M3 8L12 21L21 8" />
          <line x1="3" y1="8" x2="21" y2="8" />
        </svg>
      )
    case 'flame':
      return (
        <svg {...props}>
          <path
            d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
            fill={`${color}30`}
          />
        </svg>
      )
    case 'chess':
      return (
        <svg {...props}>
          <path d="M8 16L6 20H18L16 16" />
          <path d="M9 8L7 12H17L15 8" />
          <path d="M10 4H14" />
          <line x1="12" y1="2" x2="12" y2="4" />
          <path d="M7 20H17V22H7V20Z" fill={`${color}30`} />
        </svg>
      )
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
        </svg>
      )
  }
}
