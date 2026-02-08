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
    { href: '/u/adelinewen1107', label: isZh ? '联系我们' : 'Contact Us', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
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
