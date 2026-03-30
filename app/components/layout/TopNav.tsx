import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import NavLinks from './NavLinks'
import TopNavClient from './TopNavClient'

/**
 * TopNav — server-rendered shell with static logo + nav links.
 * Interactive parts (search, user menu, notifications) live in TopNavClient.
 * This split reduces the initial JS bundle and improves TTFB.
 */
export default function TopNav({ email = null }: { email?: string | null }) {
  return (
    <header
      className="top-nav glass top-nav-header"
      style={{
        background: tokens.glass.bg.primary,
        paddingTop: 'env(safe-area-inset-top, 0px)',
        boxShadow: 'var(--shadow-card), var(--shadow-border-glow), var(--shadow-inset-subtle)',
      }}
    >
      <div
        className="top-nav-container top-nav-inner"
        style={{
          paddingLeft: tokens.spacing[3],
          paddingRight: tokens.spacing[3],
          gap: tokens.spacing[2],
        }}
      >
        {/* Left: Logo + Nav (server-rendered, zero JS) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
          <Link
            href="/"
            className="top-nav-logo top-nav-logo-link touch-target"
            aria-label="Back to Home"
            tabIndex={0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              textDecoration: 'none',
              padding: '4px',
              marginLeft: '-4px',
            }}
          >
            <div
              data-logo-box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: `opacity ${tokens.transition.base}`,
              }}
            >
              <Image
                src="/logo-symbol-56.png"
                alt="arena"
                width={28}
                height={28}
                priority
                style={{ flexShrink: 0, borderRadius: 4, objectFit: 'contain' }}
              />
              <div
                style={{
                  fontSize: '20px',
                  fontWeight: 700,
                  color: 'var(--color-text-primary)',
                  letterSpacing: '-0.3px',
                  fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
                }}
              >
                <span style={{ color: 'var(--color-brand)', fontWeight: 800 }}>a</span>rena
              </div>
            </div>
          </Link>

          <NavLinks />
        </div>

        {/* Center + Right: interactive client parts */}
        <TopNavClient email={email} />
      </div>
    </header>
  )
}
