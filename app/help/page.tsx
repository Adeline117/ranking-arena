'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ContactSupportButton from '@/app/components/ui/ContactSupportButton'

// FAQ data using i18n
const getFaqData = (t: (key: string) => string) => {
  return {
    gettingStarted: {
      title: t('helpGettingStartedTitle'),
      items: [
        { q: t('helpWhatIsArenaQ'), a: t('helpWhatIsArenaA') },
        { q: t('helpHowToStartQ'), a: t('helpHowToStartA') },
        { q: t('helpArenaScoreQ'), a: t('helpArenaScoreA') },
        { q: t('helpFollowTraderQ'), a: t('helpFollowTraderA') },
        { q: t('helpJoinGroupQ'), a: t('helpJoinGroupA') },
        { q: t('helpFreeVsProQ'), a: t('helpFreeVsProA') },
      ],
    },
    subscription: {
      title: t('helpSubscriptionTitle'),
      items: [
        { q: t('helpUpgradeQ'), a: t('helpUpgradeA') },
        { q: t('helpPaymentMethodsQ'), a: t('helpPaymentMethodsA') },
        { q: t('helpRefundQ'), a: t('helpRefundA') },
        { q: t('helpCancelSubQ'), a: t('helpCancelSubA') },
        { q: t('helpYearlyVsMonthlyQ'), a: t('helpYearlyVsMonthlyA') },
      ],
    },
    features: {
      title: t('helpFeaturesTitle'),
      items: [
        { q: t('helpCategoryRankingQ'), a: t('helpCategoryRankingA') },
        { q: t('helpCompareQ'), a: t('helpCompareA') },
        { q: t('helpAlertsQ'), a: t('helpAlertsA') },
        { q: t('helpScoreBreakdownQ'), a: t('helpScoreBreakdownA') },
        { q: t('helpAdvancedFilterQ'), a: t('helpAdvancedFilterA') },
        { q: t('helpProGroupsQ'), a: t('helpProGroupsA') },
        { q: t('helpOfficialGroupQ'), a: t('helpOfficialGroupA') },
      ],
    },
    account: {
      title: t('helpAccountTitle'),
      items: [
        { q: t('helpChangePasswordQ'), a: t('helpChangePasswordA') },
        { q: t('helpBindExchangeQ'), a: t('helpBindExchangeA') },
        { q: t('helpDataSecurityQ'), a: t('helpDataSecurityA') },
        { q: t('helpProBadgeToggleQ'), a: t('helpProBadgeToggleA') },
      ],
    },
    contact: {
      title: t('helpContactTitle'),
      items: [
        { q: t('helpContactSupportQ'), a: t('helpContactSupportA') },
        { q: t('helpFeedbackQ'), a: t('helpFeedbackA') },
      ],
    },
  }
}

// 展开/收起图标
const ChevronIcon = ({ isOpen }: { isOpen: boolean }) => (
  <svg 
    width={20} 
    height={20} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2"
    style={{
      transition: 'transform 0.2s',
      transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
    }}
  >
    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// FAQ 项组件
function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Box
      style={{
        borderBottom: '1px solid var(--color-border-primary)',
      }}
    >
      <Box
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing[4]} 0`,
          cursor: 'pointer',
          transition: 'color 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--color-pro-gradient-start)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--color-text-primary)'
        }}
      >
        <Text size="sm" weight="semibold" style={{ flex: 1, paddingRight: tokens.spacing[3] }}>
          {question}
        </Text>
        <Box style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          <ChevronIcon isOpen={isOpen} />
        </Box>
      </Box>
      
      {isOpen && (
        <Box
          className="faq-item-content"
          style={{
            paddingBottom: tokens.spacing[4],
            paddingRight: tokens.spacing[6],
          }}
        >
          <Text size="sm" color="secondary" style={{ lineHeight: 1.7 }}>
            {answer}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// FAQ 分类组件
function FaqSection({ title, items }: { title: string; items: Array<{ q: string; a: string }> }) {
  return (
    <Box
      style={{
        marginBottom: tokens.spacing[6],
      }}
    >
      <Text 
        size="lg" 
        weight="bold" 
        style={{ 
          marginBottom: tokens.spacing[4],
          paddingBottom: tokens.spacing[2],
          borderBottom: '2px solid var(--color-pro-gradient-start)',
          display: 'inline-block',
        }}
      >
        {title}
      </Text>
      <Box>
        {items.map((item, idx) => (
          <FaqItem key={idx} question={item.q} answer={item.a} />
        ))}
      </Box>
    </Box>
  )
}


export default function HelpPage() {
  const { t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const faqData = getFaqData(t)

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    }).catch(() => { /* Intentionally swallowed: auth check non-critical for help page */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [])

  // Filter FAQ items by search query
  const filterItems = (items: Array<{ q: string; a: string }>) => {
    if (!searchQuery.trim()) return items
    const query = searchQuery.toLowerCase()
    return items.filter(
      (item) =>
        item.q.toLowerCase().includes(query) ||
        item.a.toLowerCase().includes(query)
    )
  }

  const filteredSections = Object.entries(faqData)
    .map(([key, section]) => ({
      key,
      title: section.title,
      items: filterItems(section.items),
    }))
    .filter((section) => section.items.length > 0)

  const hasResults = filteredSections.length > 0

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      {/* Background */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: `radial-gradient(ellipse at 30% 20%, var(--color-pro-glow) 0%, transparent 50%),
                       radial-gradient(ellipse at 70% 80%, var(--color-accent-primary-08) 0%, transparent 50%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      <TopNav email={email} />

      <Box
        style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: tokens.spacing[6],
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* 标题 */}
        <Box style={{ textAlign: 'center', marginBottom: tokens.spacing[8] }}>
          <Text 
            as="h1" 
            size="3xl" 
            weight="black" 
            style={{ marginBottom: tokens.spacing[3] }}
          >
            {t('helpCenter')}
          </Text>
          <Text size="md" color="secondary">
            {t('helpSubtitle')}
          </Text>
        </Box>

        {/* 快速操作 */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[8],
          }}
        >
          <Link href="/pricing" style={{ textDecoration: 'none' }}>
            <Box
              style={{
                padding: tokens.spacing[4],
                background: 'var(--color-pro-glow)',
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--color-pro-gradient-start)',
                textAlign: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 24px var(--color-pro-badge-shadow)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            >
              <Box style={{ marginBottom: tokens.spacing[2] }}>
                <svg width={24} height={24} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start)">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
              </Box>
              <Text size="sm" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
                {t('upgradeToPro')}
              </Text>
            </Box>
          </Link>

          <Link href="/settings" style={{ textDecoration: 'none' }}>
            <Box
              style={{
                padding: tokens.spacing[4],
                background: 'var(--color-bg-secondary)',
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--color-border-primary)',
                textAlign: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-text-tertiary)'
                e.currentTarget.style.transform = 'translateY(-2px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border-primary)'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <Box style={{ marginBottom: tokens.spacing[2] }}>
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </Box>
              <Text size="sm" weight="bold" color="secondary">
                {t('helpAccountSettings')}
              </Text>
            </Box>
          </Link>

          <ContactSupportButton
            variant="card"
            label={t('contactSupport')}
          />
        </Box>

        {/* Search */}
        <Box style={{ marginBottom: tokens.spacing[5] }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('faqSearchPlaceholder')}
            style={{
              width: '100%',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-primary)',
              borderRadius: tokens.radius.lg,
              color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.sm,
              outline: 'none',
              transition: `border-color ${tokens.transition.fast}`,
              boxSizing: 'border-box',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-pro-gradient-start)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-primary)'
            }}
          />
        </Box>

        {/* FAQ content */}
        <Box
          style={{
            background: 'var(--color-bg-secondary)',
            borderRadius: tokens.radius.xl,
            border: '1px solid var(--color-border-primary)',
            padding: tokens.spacing[6],
          }}
        >
          {hasResults ? (
            filteredSections.map((section) => (
              <FaqSection key={section.key} title={section.title} items={section.items} />
            ))
          ) : (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
              <Text size="sm" color="tertiary">
                {t('faqNoResults')}
              </Text>
            </Box>
          )}
        </Box>

        {/* 底部 */}
        <Box style={{ textAlign: 'center', marginTop: tokens.spacing[8], display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" color="tertiary">
            {t('helpNoAnswer')}
          </Text>
          <ContactSupportButton
            variant="link"
            label={t('helpMessageUs')}
          />
        </Box>
      </Box>

      {/* 动画样式 */}
      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}
