'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

const CURRENT_YEAR = new Date().getFullYear()

export default function Footer() {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const navLinks = [
    { href: '/', label: isZh ? '排行榜' : 'Rankings' },
    { href: '/groups', label: isZh ? '社区' : 'Groups' },
    { href: '/hot', label: isZh ? '热门' : 'Hot' },
    { href: '/library', label: isZh ? '知识库' : 'Library' },
  ]

  const legalLinks = [
    { href: '/about', label: isZh ? '关于' : 'About' },
    { href: '/help', label: isZh ? '帮助' : 'Help' },
    { href: '/legal/terms', label: isZh ? '服务条款' : 'Terms of Service' },
    { href: '/legal/privacy', label: isZh ? '隐私政策' : 'Privacy Policy' },
    { href: '/legal/disclaimer', label: isZh ? '免责声明' : 'Disclaimer' },
  ]

  const socialLinks = [
    { href: 'https://x.com/ArenaFi_com', label: 'X / Twitter', icon: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
    { href: 'https://discord.gg/arenafi', label: 'Discord', icon: 'M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z' },
    { href: 'https://t.me/arenafi', label: 'Telegram', icon: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12.056 0h-.112zM8.016 9.184c.073-.054 4.862-2.03 4.862-2.03l1.665-.692s.594-.233.545.33c-.017.187-.1.845-.183 1.553l-.762 5.07s-.066.548-.617.548c-.55 0-.917-.363-1.217-.613L10.083 11.5l-.767.742s-.183.167-.367.062l.35-2.062z' },
  ]

  return (
    <footer
      style={{
        marginTop: 48,
        padding: '32px 16px 24px',
        borderTop: `1px solid var(--color-border-primary)`,
        maxWidth: 1400,
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
    >
      {/* Navigation links */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 24,
          flexWrap: 'wrap',
          marginBottom: 20,
        }}
      >
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: 'var(--color-text-secondary)',
              textDecoration: 'none',
              fontWeight: tokens.typography.fontWeight.medium,
              transition: `color ${tokens.transition.fast}`,
            }}
          >
            {link.label}
          </Link>
        ))}
      </div>

      {/* Legal links */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 20,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        {legalLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: 'var(--color-text-tertiary)',
              textDecoration: 'none',
            }}
          >
            {link.label}
          </Link>
        ))}
      </div>

      {/* Social links */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 16,
          marginBottom: 20,
        }}
      >
        {socialLinks.map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={link.label}
            style={{
              color: 'var(--color-text-tertiary)',
              transition: `color ${tokens.transition.fast}`,
              display: 'flex',
              alignItems: 'center',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--color-text-primary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--color-text-tertiary)'
            }}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor">
              <path d={link.icon} />
            </svg>
          </a>
        ))}
      </div>

      {/* Disclaimer */}
      <p
        style={{
          textAlign: 'center',
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          lineHeight: 1.6,
          maxWidth: 600,
          margin: '0 auto 12px',
        }}
      >
        {isZh
          ? '本站数据仅供参考，不构成任何投资建议。加密货币交易存在高风险，请谨慎决策。'
          : 'Data provided on this site is for informational purposes only and does not constitute investment advice. Cryptocurrency trading involves significant risk.'}
      </p>

      {/* Copyright */}
      <p
        style={{
          textAlign: 'center',
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          margin: 0,
        }}
      >
        &copy; {CURRENT_YEAR} Arena. All rights reserved.
      </p>
    </footer>
  )
}
