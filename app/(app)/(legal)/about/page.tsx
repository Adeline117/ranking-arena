'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import Footer from '@/app/components/layout/Footer'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <Box
      style={{
        padding: tokens.spacing[5],
        background: 'var(--color-bg-secondary)',
        borderRadius: tokens.radius.lg,
        border: '1px solid var(--color-border-primary)',
        transition: `border-color ${tokens.transition.fast}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-pro-gradient-start)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border-primary)'
      }}
    >
      <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
        {title}
      </Text>
      <Text size="sm" color="secondary" style={{ lineHeight: 1.7 }}>
        {description}
      </Text>
    </Box>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box style={{ marginBottom: tokens.spacing[8] }}>
      <Text
        as="h2"
        size="xl"
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
      {children}
    </Box>
  )
}


export default function AboutPage() {
  const { t } = useLanguage()

  const features = [
    { title: t('aboutFeature1Title'), desc: t('aboutFeature1Desc') },
    { title: t('aboutFeature2Title'), desc: t('aboutFeature2Desc') },
    { title: t('aboutFeature3Title'), desc: t('aboutFeature3Desc') },
    { title: t('aboutFeature4Title'), desc: t('aboutFeature4Desc') },
    { title: t('aboutFeature5Title'), desc: t('aboutFeature5Desc') },
    { title: t('aboutFeature6Title'), desc: t('aboutFeature6Desc') },
  ]

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      {/* Background gradient */}
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

      <TopNav />

      <Box
        style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: tokens.spacing[6],
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Header */}
        <Box style={{ textAlign: 'center', marginBottom: tokens.spacing[8] }}>
          <Text as="h1" size="3xl" weight="black" style={{ marginBottom: tokens.spacing[3] }}>
            {t('aboutTitle')}
          </Text>
          <Text size="md" color="secondary">
            {t('aboutSubtitle')}
          </Text>
        </Box>

        {/* Introduction */}
        <Section title={t('aboutIntroTitle')}>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.8, marginBottom: tokens.spacing[3] }}>
            {t('aboutIntroP1')}
          </Text>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.8 }}>
            {t('aboutIntroP2')}
          </Text>
        </Section>

        {/* Features */}
        <Section title={t('aboutFeaturesTitle')}>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: tokens.spacing[4],
            }}
          >
            {features.map((f, i) => (
              <FeatureCard key={i} title={f.title} description={f.desc} />
            ))}
          </Box>
        </Section>

        {/* Data Sources */}
        <Section title={t('aboutDataTitle')}>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.8, marginBottom: tokens.spacing[4] }}>
            {t('aboutDataDesc')}
          </Text>
          <Box
            style={{
              background: 'var(--color-bg-secondary)',
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary)',
              padding: tokens.spacing[5],
            }}
          >
            {[t('aboutDataCEX'), t('aboutDataDEX'), t('aboutDataOnChain')].map((item, i) => (
              <Box
                key={i}
                style={{
                  padding: `${tokens.spacing[2]} 0`,
                  borderBottom: i < 2 ? '1px solid var(--color-border-primary)' : 'none',
                }}
              >
                <Text size="sm" color="secondary" style={{ lineHeight: 1.7 }}>
                  {item}
                </Text>
              </Box>
            ))}
          </Box>
        </Section>

        {/* Statistics */}
        <Section title={t('aboutStatsTitle')}>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: tokens.spacing[4],
            }}
          >
            {[
              { value: t('aboutStatTraders'), label: t('aboutStatTradersLabel') },
              { value: t('aboutStatExchanges'), label: t('aboutStatExchangesLabel') },
              { value: t('aboutStatResources'), label: t('aboutStatResourcesLabel') },
              { value: t('aboutStatInstitutions'), label: t('aboutStatInstitutionsLabel') },
            ].map((stat, i) => (
              <Box
                key={i}
                style={{
                  padding: tokens.spacing[5],
                  background: 'var(--color-bg-secondary)',
                  borderRadius: tokens.radius.lg,
                  border: '1px solid var(--color-border-primary)',
                  textAlign: 'center',
                }}
              >
                <Text
                  size="2xl"
                  weight="black"
                  style={{
                    background: 'linear-gradient(135deg, var(--color-pro-gradient-start), var(--color-pro-gradient-end))',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    marginBottom: tokens.spacing[1],
                  }}
                >
                  {stat.value}
                </Text>
                <Text size="xs" color="secondary">
                  {stat.label}
                </Text>
              </Box>
            ))}
          </Box>
        </Section>

        {/* Vision */}
        <Section title={t('aboutVisionTitle')}>
          <Box
            style={{
              padding: tokens.spacing[5],
              background: 'var(--color-pro-glow)',
              borderRadius: tokens.radius.lg,
              borderLeft: '4px solid var(--color-pro-gradient-start)',
            }}
          >
            <Text size="sm" color="secondary" style={{ lineHeight: 1.8, fontStyle: 'italic' }}>
              {t('aboutVisionDesc')}
            </Text>
          </Box>
        </Section>

        {/* Contact */}
        <Section title={t('aboutContactTitle')}>
          <Box
            style={{
              padding: tokens.spacing[5],
              background: 'var(--color-bg-secondary)',
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary)',
            }}
          >
            <Text size="sm" color="secondary" style={{ lineHeight: 1.8, marginBottom: tokens.spacing[3] }}>
              {t('aboutContactDesc')}
            </Text>
            <Link
              href="/u/adelinewen1107"
              style={{
                color: 'var(--color-pro-gradient-start)',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {t('aboutContactLink')} →
            </Link>
          </Box>
        </Section>
      </Box>

      <Footer />
    </Box>
  )
}
