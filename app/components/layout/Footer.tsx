'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

interface FooterColumn {
  title: string
  links: { href: string; label: string; external?: boolean }[]
}

export default function Footer() {
  const { t, language } = useLanguage()

  const columns: FooterColumn[] = [
    {
      title: t('footerProduct'),
      links: [
        { href: '/rankings', label: t('footerRankings') },
        { href: '/market', label: t('footerMarket') },
        { href: '/library', label: t('footerLibrary') },
      ],
    },
    {
      title: t('footerCommunity'),
      links: [
        { href: '/groups', label: t('footerGroups') },
        { href: '/hot', label: t('footerHot') },
      ],
    },
    {
      title: t('footerLegal'),
      links: [
        { href: '/terms', label: t('footerTerms') },
        { href: '/privacy', label: t('footerPrivacy') },
        { href: '/disclaimer', label: t('footerDisclaimer') },
        { href: '/dmca', label: t('footerDmca') },
      ],
    },
    {
      title: t('footerAbout'),
      links: [
        { href: '/methodology', label: t('footerMethodology') },
        { href: '/u/adelinewen1107', label: t('footerContact') },
        { href: '/help', label: t('footerHelp') },
        { href: '/status', label: t('footerStatus') },
      ],
    },
  ]

  return (
    <footer
      className="hide-mobile-nav"
      style={{
        marginTop: tokens.spacing[8],
        borderTop: `1px solid var(--color-border-primary)`,
        maxWidth: 1200,
        marginLeft: 'auto',
        marginRight: 'auto',
        padding: `${tokens.spacing[10]} ${tokens.spacing[4]} ${tokens.spacing[8]}`,
      }}
    >
      {/* Column grid */}
      <div
        className="footer-columns"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: tokens.spacing[6],
          marginBottom: tokens.spacing[6],
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
          &copy; {new Date().getFullYear()} Arena. {t('footerSlogan')}
        </p>

        {/* X / Twitter */}
        <a
          href="https://x.com/Arena_English"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="X / Twitter"
          className="footer-link"
          style={{
            color: 'var(--color-text-tertiary)',
            transition: `color ${tokens.transition.fast}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 44,
            minHeight: 44,
          }}
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>

        {/* Telegram */}
        <a
          href="https://t.me/ArenaFi_Official"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Telegram"
          className="footer-link"
          style={{
            color: 'var(--color-text-tertiary)',
            transition: `color ${tokens.transition.fast}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 44,
            minHeight: 44,
          }}
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
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
        }}
      >
        {t('footerDisclaimerText')}
      </p>
    </footer>
  )
}
