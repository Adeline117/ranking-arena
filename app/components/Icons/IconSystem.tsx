'use client'

import React from 'react'

export interface IconProps {
  size?: number
  style?: React.CSSProperties
  className?: string
  [key: string]: any
}

// Trophy Icon
export function TrophyIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path
        d="M8 2v2M5 4h6M4 6h8v6H4V6zM6 12h4M8 8v4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Search Icon
export function SearchIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10 10 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Chart Icon
export function ChartIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path
        d="M2 12h12M4 8l2 2 4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// User Icon
export function UserIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <circle cx="8" cy="6" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 14a5 5 0 0 1 10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Like Icon
export function LikeIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path
        d="M8 13V7M5 7h6l1-4H4v6h1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Comment Icon
export function CommentIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path
        d="M3 3h10v6H6l-3 3V3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Dashboard Icon
export function DashboardIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <rect x="2" y="2" width="5" height="5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="5" height="5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="5" height="5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

// Notification Icon
export function NotificationIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path
        d="M8 2v1M4 6a4 4 0 0 1 8 0v3l2 2H2l2-2V6zM6 13h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Badge Icon
export function BadgeIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Arrow Right Icon
export function ArrowRightIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Arrow Left Icon
export function ArrowLeftIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Close / X Icon
export function CloseIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Chevron Down Icon
export function ChevronDownIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Plus Icon
export function PlusIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path d="M8 4v8M4 8h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Settings Icon
export function SettingsIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 2v1M8 13v1M2 8h1M13 8h1M3.5 3.5l.7.7M11.8 11.8l.7.7M3.5 12.5l.7-.7M11.8 4.2l.7-.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

// Ranking Badge
export function RankingBadge({ rank, size = 24 }: { rank: 1 | 2 | 3; size?: number }) {
  const colors = {
    1: '#FFD700', // Gold
    2: '#C0C0C0', // Silver
    3: '#CD7F32', // Bronze
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <circle cx="12" cy="12" r="10" fill={colors[rank]} stroke="currentColor" strokeWidth="1.5" />
      <text x="12" y="16" textAnchor="middle" fontSize="12" fontWeight="bold" fill="currentColor">
        {rank}
      </text>
    </svg>
  )
}

// Sun Icon (for light theme)
export function SunIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1v2M8 13v2M15 8h-2M3 8H1M13.5 2.5l-1.4 1.4M3.9 12.1l-1.4 1.4M13.5 13.5l-1.4-1.4M3.9 3.9l-1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

// Moon Icon (for dark theme)
export function MoonIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      {...props}
    >
      <path
        d="M6 2a6 6 0 1 0 8 8 4 4 0 0 1-8-8z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
