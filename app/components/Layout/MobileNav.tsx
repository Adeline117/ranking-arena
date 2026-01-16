'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '../Utils/LanguageProvider'

interface NavItem {
  href: string
  label: string
  icon: React.ReactNode
  activeIcon?: React.ReactNode
}

/**
 * 移动端底部导航栏
 */
export function MobileNav() {
  const pathname = usePathname()
  const { t } = useLanguage()

  const navItems: NavItem[] = [
    {
      href: '/',
      label: t('ranking') || '排行榜',
      icon: <RankingIcon />,
      activeIcon: <RankingIconFilled />,
    },
    {
      href: '/hot',
      label: t('hot') || '热门',
      icon: <FireIcon />,
      activeIcon: <FireIconFilled />,
    },
    {
      href: '/search',
      label: t('search') || '搜索',
      icon: <SearchIcon />,
      activeIcon: <SearchIconFilled />,
    },
    {
      href: '/notifications',
      label: t('notifications') || '通知',
      icon: <BellIcon />,
      activeIcon: <BellIconFilled />,
    },
    {
      href: '/settings',
      label: t('me') || '我的',
      icon: <UserIcon />,
      activeIcon: <UserIconFilled />,
    },
  ]

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[var(--color-bg-secondary)] border-t border-[var(--color-border-primary)] safe-area-inset-bottom">
      <div className="flex items-center justify-around h-14">
        {navItems.map((item) => {
          const isActive = pathname === item.href || 
            (item.href !== '/' && pathname.startsWith(item.href))

          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={true}
              className={`flex flex-col items-center justify-center flex-1 h-full py-1 transition-colors ${
                isActive 
                  ? 'text-[var(--color-accent-primary)]' 
                  : 'text-[var(--color-text-tertiary)]'
              }`}
            >
              <div className="w-6 h-6">
                {isActive ? item.activeIcon || item.icon : item.icon}
              </div>
              <span className={`text-[10px] mt-0.5 ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {item.label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

// ============================================
// 图标组件
// ============================================

function RankingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </svg>
  )
}

function RankingIconFilled() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 3v18h18v-2H5V3H3z" />
      <rect x="16" y="9" width="4" height="8" rx="1" />
      <rect x="11" y="5" width="4" height="12" rx="1" />
      <rect x="6" y="14" width="4" height="3" rx="1" />
    </svg>
  )
}

function FireIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  )
}

function FireIconFilled() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2c-1.5 2-2 4-1.5 6-1.5-1-2.5-2-2.5-4-2 2-3 4.5-3 7a7 7 0 1 0 14 0c0-3-2-5.5-4-7 0 2-1 3.5-2 4-.5-2-1-4-.5-6z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function SearchIconFilled() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M11 2a9 9 0 1 0 5.618 16.032l3.675 3.675a1 1 0 0 0 1.414-1.414l-3.675-3.675A9 9 0 0 0 11 2zm-6 9a6 6 0 1 1 12 0 6 6 0 0 1-12 0z" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function BellIconFilled() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  )
}

function UserIconFilled() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  )
}

export default MobileNav
