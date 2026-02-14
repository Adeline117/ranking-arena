'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import ContactSupportButton from '@/app/components/ui/ContactSupportButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function PrivacyPolicyPage() {
  const { t } = useLanguage()

  return (
    <Box
      style={{
        maxWidth: 800,
        margin: '0 auto',
        padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
      }}
    >
      <Text size="3xl" weight="bold" style={{ marginBottom: tokens.spacing[6] }}>
        {t('privacyPolicyTitle')}
      </Text>

      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[8] }}>
        {t('privacyLastUpdated')}
      </Text>

      <Section title={t('privacyOverviewTitle')}>
        <Paragraph>
          {t('privacyOverviewP1')}
        </Paragraph>
        <Paragraph>
          {t('privacyOverviewP2')}
        </Paragraph>
      </Section>

      <Section title={t('privacyInfoCollectedTitle')}>
        <SubSection title={t('privacyInfoProvidedTitle')}>
          <List items={[
            t('privacyInfoProvided1'),
            t('privacyInfoProvided2'),
            t('privacyInfoProvided3'),
            t('privacyInfoProvided4'),
          ]} />
        </SubSection>

        <SubSection title={t('privacyInfoAutoTitle')}>
          <List items={[
            t('privacyInfoAuto1'),
            t('privacyInfoAuto2'),
            t('privacyInfoAuto3'),
            t('privacyInfoAuto4'),
          ]} />
        </SubSection>

        <SubSection title={t('privacyInfoThirdPartyTitle')}>
          <List items={[
            t('privacyInfoThirdParty1'),
            t('privacyInfoThirdParty2'),
          ]} />
        </SubSection>
      </Section>

      <Section title={t('privacyUsePurposeTitle')}>
        <Paragraph>
          {t('privacyUsePurposeIntro')}
        </Paragraph>
        <List items={[
          t('privacyUsePurpose1'),
          t('privacyUsePurpose2'),
          t('privacyUsePurpose3'),
          t('privacyUsePurpose4'),
          t('privacyUsePurpose5'),
          t('privacyUsePurpose6'),
          t('privacyUsePurpose7'),
        ]} />
      </Section>

      <Section title={t('privacyInfoSharingTitle')}>
        <Paragraph>
          {t('privacyInfoSharingIntro')}
        </Paragraph>
        <List items={[
          t('privacyInfoSharing1'),
          t('privacyInfoSharing2'),
          t('privacyInfoSharing3'),
          t('privacyInfoSharing4'),
        ]} />
      </Section>

      <Section title={t('privacyDataSecurityTitle')}>
        <Paragraph>
          {t('privacyDataSecurityIntro')}
        </Paragraph>
        <List items={[
          t('privacyDataSecurity1'),
          t('privacyDataSecurity2'),
          t('privacyDataSecurity3'),
          t('privacyDataSecurity4'),
          t('privacyDataSecurity5'),
        ]} />
        <Paragraph>
          {t('privacyDataSecurityNote')}
        </Paragraph>
      </Section>

      <Section title={t('privacyYourRightsTitle')}>
        <Paragraph>
          {t('privacyYourRightsIntro')}
        </Paragraph>
        <List items={[
          t('privacyYourRights1'),
          t('privacyYourRights2'),
          t('privacyYourRights3'),
          t('privacyYourRights4'),
          t('privacyYourRights5'),
          t('privacyYourRights6'),
        ]} />
        <Paragraph>
          {t('privacyYourRightsContact')}
          <Box style={{ marginTop: tokens.spacing[2] }}>
            <ContactSupportButton variant="link" label={t('privacySendMessage')} />
          </Box>
        </Paragraph>
      </Section>

      <Section title={t('privacyDataRetentionTitle')}>
        <Paragraph>
          {t('privacyDataRetentionIntro')}
        </Paragraph>
        <List items={[
          t('privacyDataRetention1'),
          t('privacyDataRetention2'),
          t('privacyDataRetention3'),
          t('privacyDataRetention4'),
        ]} />
      </Section>

      <Section title={t('privacyCookieTitle')}>
        <Paragraph>
          {t('privacyCookieIntro')}
        </Paragraph>
        <List items={[
          t('privacyCookie1'),
          t('privacyCookie2'),
          t('privacyCookie3'),
        ]} />
        <Paragraph>
          {t('privacyCookieNote')}
        </Paragraph>
      </Section>

      <Section title={t('privacyInternationalTitle')}>
        <Paragraph>
          {t('privacyInternationalP1')}
        </Paragraph>
      </Section>

      <Section title={t('privacyMinorsTitle')}>
        <Paragraph>
          {t('privacyMinorsP1')}
        </Paragraph>
      </Section>

      <Section title={t('privacyChangesTitle')}>
        <Paragraph>
          {t('privacyChangesP1')}
        </Paragraph>
      </Section>

      <Section title={t('privacyContactTitle')}>
        <Paragraph>
          {t('privacyContactP1')}
        </Paragraph>
        <Box
          style={{
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            marginTop: tokens.spacing[3],
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[2],
          }}
        >
          <Text size="sm">{t('privacyContactLabel')}</Text>
          <ContactSupportButton size="sm" label={t('privacySendMessageToSupport')} />
        </Box>
      </Section>
    </Box>
  )
}

// ============================================
// 辅助组件
// ============================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box style={{ marginBottom: tokens.spacing[8] }}>
      <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
        {title}
      </Text>
      {children}
    </Box>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      <Text size="lg" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
        {title}
      </Text>
      {children}
    </Box>
  )
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return (
    <Text
      size="sm"
      color="secondary"
      style={{
        marginBottom: tokens.spacing[3],
        lineHeight: 1.7,
      }}
    >
      {children}
    </Text>
  )
}

function List({ items }: { items: string[] }) {
  return (
    <Box
      as="ul"
      style={{
        paddingLeft: tokens.spacing[5],
        marginBottom: tokens.spacing[4],
      }}
    >
      {items.map((item, index) => (
        <Box
          as="li"
          key={index}
          style={{
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.7,
            marginBottom: tokens.spacing[2],
          }}
        >
          {item}
        </Box>
      ))}
    </Box>
  )
}
