'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

interface FooterColumn {
  title: string
  links: { href: string; label: string; external?: boolean }[]
}

export default function Footer() {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const columns: FooterColumn[] = [
    {
      title: isZh ? '产品' : 'Product',
      links: [
        { href: '/', label: isZh ? '排行榜' : 'Rankings' },
        { href: '/market', label: isZh ? '市场' : 'Market' },
        { href: '/library', label: isZh ? '知识库' : 'Library' },
      ],
    },
    {
      title: isZh ? '社区' : 'Community',
      links: [
        { href: '/groups', label: isZh ? '小组' : 'Groups' },
        { href: '/hot', label: isZh ? '热门' : 'Hot' },
      ],
    },
    {
      title: isZh ? '法律' : 'Legal',
      links: [
        { href: '/terms', label: isZh ? '服务条款' : 'Terms' },
        { href: '/privacy', label: isZh ? '隐私政策' : 'Privacy' },
        { href: '/disclaimer', label: isZh ? '风险免责声明' : 'Disclaimer' },
        { href: '/dmca', label: isZh ? '版权政策' : 'DMCA' },
      ],
    },
    {
      title: isZh ? '关于' : 'About',
      links: [
        { href: '/u/adelinewen1107', label: isZh ? '联系我们' : 'Contact' },
      { href: '/help', label: isZh ? '帮助中心' : 'Help' },
      { href: '/status', label: isZh ? '系统状态' : 'Status' },
      ],
    },
  ]

  return (
    <footer
      className="hide-mobile-nav"
      style={{
        marginTop: 64,
        borderTop: `1px solid var(--color-border-primary)`,
        maxWidth: 1200,
        marginLeft: 'auto',
        marginRight: 'auto',
        padding: '40px 16px 32px',
      }}
    >
      {/* Column grid */}
      <div
        className="footer-columns"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 32,
          marginBottom: 32,
        }}
      >
        {columns.map((col) => (
          <div key={col.title}>
            <p
              style={{
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
                color: 'var(--color-text-primary)',
                marginBottom: 12,
                letterSpacing: '0.5px',
                textTransform: language === 'en' ? 'uppercase' : undefined,
              }}
            >
              {col.title}
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {col.links.map((link) => (
                <li key={link.href}>
                  {link.external ? (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="footer-link"
                      style={{
                        fontSize: tokens.typography.fontSize.sm,
                        color: 'var(--color-text-tertiary)',
                        textDecoration: 'none',
                        transition: `color ${tokens.transition.fast}`,
                      }}
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      className="footer-link"
                      style={{
                        fontSize: tokens.typography.fontSize.sm,
                        color: 'var(--color-text-tertiary)',
                        textDecoration: 'none',
                        transition: `color ${tokens.transition.fast}`,
                      }}
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Social + copyright row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 16,
          paddingTop: 20,
          borderTop: `1px solid var(--color-border-primary)`,
          transition: `border-color ${tokens.transition.base}`,
        }}
      >
        <p
          style={{
            fontSize: tokens.typography.fontSize.xs,
            color: 'var(--color-text-tertiary)',
            margin: 0,
          }}
        >
          &copy; {new Date().getFullYear()} Arena. {isZh ? '入场，超越。' : 'Enter. Outperform.'}
        </p>

        {/* X / Twitter */}
        <a
          href="https://x.com/Arena_com"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="X / Twitter"
          className="footer-link"
          style={{
            color: 'var(--color-text-tertiary)',
            transition: `color ${tokens.transition.fast}`,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
      </div>

      {/* Disclaimer */}
      <p
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
          lineHeight: 1.6,
          marginTop: 16,
          marginBottom: 0,
          opacity: 0.7,
        }}
      >
        {isZh
          ? '本站数据仅供参考，不构成任何投资建议。加密货币交易存在高风险，请谨慎决策。'
          : 'Data provided is for informational purposes only and does not constitute investment advice. Cryptocurrency trading involves significant risk.'}
      </p>
    </footer>
  )
}
