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
    { href: '/compare', label: isZh ? '对比' : 'Compare' },
  ]

  const legalLinks = [
    { href: '/legal/terms', label: isZh ? '服务条款' : 'Terms of Service' },
    { href: '/legal/privacy', label: isZh ? '隐私政策' : 'Privacy Policy' },
    { href: '/legal/disclaimer', label: isZh ? '免责声明' : 'Disclaimer' },
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
