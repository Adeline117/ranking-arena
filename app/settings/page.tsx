'use client'

import React, { Suspense, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered in root layout.tsx — do not duplicate here
import { Box, Text, Button } from '@/app/components/base'
import dynamic from 'next/dynamic'
const ExchangeConnectionManager = dynamic(() => import('@/app/components/exchange/ExchangeConnection'), { ssr: false })
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
const AdvancedAlerts = dynamic(() => import('@/app/components/pro/AdvancedAlerts'), { ssr: false })
const ReferralCard = dynamic(() => import('@/app/components/profile/ReferralCard'), { ssr: false })
const WalletSection = dynamic(() => import('@/lib/web3/wallet-components').then(m => ({ default: m.WalletSection })), { ssr: false })
const LazyWeb3Boundary = dynamic(() => import('@/lib/web3/wallet-components').then(m => ({ default: m.Web3Boundary })), { ssr: false })
const ImageCropper = dynamic(() => import('@/app/components/ui/ImageCropper').then(m => ({ default: m.ImageCropper })), { ssr: false })
const MobileProfileMenu = dynamic(() => import('@/app/components/profile/MobileProfileMenu'), { ssr: false })
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { useActiveSection } from './hooks/useActiveSection'
import { useSettingsHandlers } from './hooks/useSettingsHandlers'

import {
  SECTION_IDS,
  SECTION_ICONS,
  SECTION_KEYS,
  SectionCard,
  ProfileSection,
  SecuritySection,
  NotificationsSection,
  PrivacySection,
  AccountSection,
  DeleteAccountModal,
  TraderLinksSection,
  ExchangeBindingBanner,
} from './components'
import { logger } from '@/lib/logger'

function SettingsContent() {
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()
  const { activeSection, scrollToSection } = useActiveSection()
  const { isPro } = useSubscription()

  // Lazy-load flags
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [blockedUsersLoaded, setBlockedUsersLoaded] = useState(false)

  const h = useSettingsHandlers({ showToast, showConfirm, t })

  // ===== Init auth =====
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      h.setEmail(data.user?.email ?? null)
      h.setUserId(data.user?.id ?? null)
      if (!data.user) { router.push('/login?redirect=/settings'); return }
      h.loadProfile(data.user.id)
    }).catch(() => { /* Auth check failure on settings page */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
  }, [router]) // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount; h methods are stable refs defined in useSettingsHandlers

  // ===== Lazy-load sessions and blocked users =====
  useEffect(() => {
    if (activeSection === 'security' && !sessionsLoaded && !h.loadingSessions) {
      setSessionsLoaded(true)
      h.loadSessions()
    }
    if (activeSection === 'privacy' && h.userId && !blockedUsersLoaded && !h.loadingBlockedUsers) {
      setBlockedUsersLoaded(true)
      h.loadBlockedUsers(h.userId)
    }
  }, [activeSection, sessionsLoaded, blockedUsersLoaded, h.userId, h.loadingSessions, h.loadingBlockedUsers]) // eslint-disable-line react-hooks/exhaustive-deps -- h.loadSessions/h.loadBlockedUsers are stable refs, listing them causes infinite re-render

  // ===== Render: auth required / loading states =====
  if (!h.loading && !h.userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={h.email} />
        <Box style={{ maxWidth: 400, margin: '0 auto', padding: tokens.spacing[8], textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[4] }}>
          <Box style={{ width: 64, height: 64, borderRadius: tokens.radius.full, background: `${tokens.colors.accent.primary}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: tokens.spacing[2] }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          </Box>
          <Text size="xl" weight="bold">{t('loginRequired')}</Text>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>{t('loginRequiredDesc')}</Text>
          <Button variant="primary" onClick={() => router.push('/login?redirect=/settings')} style={{ marginTop: tokens.spacing[2] }}>{t('goToLogin')}</Button>
        </Box>
      </Box>
    )
  }

  if (h.loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={h.email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Box style={{ width: 32, height: 32, border: `3px solid ${tokens.colors.border.primary}`, borderTopColor: tokens.colors.accent.primary, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <Text size="lg" color="secondary">{t('loading')}</Text>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={h.email} />

      {/* Mobile profile quick-nav — shown above settings on small screens */}
      <Box className="settings-mobile-profile-menu" style={{ display: 'none', maxWidth: 900, margin: '0 auto' }}>
        <MobileProfileMenu />
      </Box>

      <Box style={{ maxWidth: 900, margin: '0 auto', paddingLeft: tokens.spacing[6], paddingRight: tokens.spacing[6] }}>
        <Breadcrumb items={[{ label: t('settings') }]} />
      </Box>
      <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], paddingTop: 0, paddingBottom: 100, display: 'flex', gap: tokens.spacing[8] }}>
        {/* Sidebar Navigation - Desktop only */}
        <Box
          className="settings-sidebar"
          style={{
            width: 180, flexShrink: 0, position: 'sticky', top: 80, alignSelf: 'flex-start',
            display: 'flex', flexDirection: 'column', gap: tokens.spacing[1],
          }}
        >
          {SECTION_IDS.map(sectionId => (
            <button
              key={sectionId}
              onClick={() => scrollToSection(sectionId)}
              style={{
                display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, minHeight: 44, borderRadius: tokens.radius.md, border: 'none',
                background: activeSection === sectionId ? tokens.colors.bg.tertiary : 'transparent',
                color: activeSection === sectionId ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontWeight: activeSection === sectionId ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                fontSize: tokens.typography.fontSize.sm, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s ease', width: '100%',
              }}
            >
              <span style={{ fontSize: '14px', display: 'flex', alignItems: 'center' }}>{SECTION_ICONS[sectionId]}</span>
              {t(SECTION_KEYS[sectionId] as keyof typeof import('@/lib/i18n').translations.zh)}
            </button>
          ))}
        </Box>

        {/* Main Content */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            {t('settingsTitle')}
          </Text>

          {/* Mobile Section Navigation */}
          <Box
            className="settings-mobile-nav"
            style={{
              display: 'none', gap: tokens.spacing[2], marginBottom: tokens.spacing[5],
              overflowX: 'auto', paddingBottom: tokens.spacing[2],
              WebkitOverflowScrolling: 'touch', msOverflowStyle: 'none', scrollbarWidth: 'none',
            }}
          >
            {SECTION_IDS.map(sectionId => (
              <button
                key={sectionId}
                onClick={() => scrollToSection(sectionId)}
                style={{
                  display: 'flex', alignItems: 'center', gap: tokens.spacing[1],
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, minHeight: 44, borderRadius: tokens.radius.full,
                  border: `1px solid ${activeSection === sectionId ? tokens.colors.accent.primary + '60' : tokens.colors.border.primary}`,
                  background: activeSection === sectionId ? `${tokens.colors.accent.primary}15` : tokens.colors.bg.secondary,
                  color: activeSection === sectionId ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: activeSection === sectionId ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, transition: 'all 0.15s ease',
                }}
              >
                <span style={{ fontSize: '12px', display: 'flex', alignItems: 'center' }}>{SECTION_ICONS[sectionId]}</span>
                {t(SECTION_KEYS[sectionId] as keyof typeof import('@/lib/i18n').translations.zh)}
              </button>
            ))}
          </Box>

          {/* Exchange Binding Banner - only for users without bound exchanges */}
          <ExchangeBindingBanner userId={h.userId} />

          <ProfileSection
            userId={h.userId}
            email={h.email}
            handle={h.handle}
            setHandle={h.setHandle}
            bio={h.bio}
            setBio={h.setBio}
            previewUrl={h.previewUrl}
            coverPreviewUrl={h.coverPreviewUrl}
            coverUrl={h.coverUrl}
            initialHandle={h.initialValuesRef.current?.handle || null}
            handleAvailable={h.handleAvailable}
            checkingHandle={h.checkingHandle}
            touchedHandle={h.touchedFields.handle}
            markTouched={() => h.markTouched('handle')}
            onAvatarChange={h.handleAvatarChange}
            onCoverChange={h.handleCoverChange}
            onRemoveCover={h.handleRemoveCover}
          />

          <SecuritySection
            email={h.email}
            newEmail={h.newEmail}
            setNewEmail={h.setNewEmail}
            savingEmail={h.savingEmail}
            onChangeEmail={h.handleChangeEmail}
            currentPassword={h.currentPassword}
            setCurrentPassword={h.setCurrentPassword}
            newPassword={h.newPassword}
            setNewPassword={h.setNewPassword}
            confirmNewPassword={h.confirmNewPassword}
            setConfirmNewPassword={h.setConfirmNewPassword}
            savingPassword={h.savingPassword}
            onChangePassword={h.handleChangePassword}
            passwordResetMode={h.passwordResetMode}
            setPasswordResetMode={h.setPasswordResetMode}
            resetCodeSent={h.resetCodeSent}
            sendingResetCode={h.sendingResetCode}
            resetCountdown={h.resetCountdown}
            onSendResetCode={h.handleSendResetCode}
            twoFAEnabled={h.twoFAEnabled}
            twoFASetupData={h.twoFASetupData}
            twoFACode={h.twoFACode}
            setTwoFACode={h.setTwoFACode}
            backupCodes={h.backupCodes}
            twoFALoading={h.twoFALoading}
            showDisable2FA={h.showDisable2FA}
            setShowDisable2FA={h.setShowDisable2FA}
            disablePassword={h.disablePassword}
            setDisablePassword={h.setDisablePassword}
            onSetup2FA={h.handleSetup2FA}
            onVerify2FA={h.handleVerify2FA}
            onDisable2FA={h.handleDisable2FA}
            sessions={h.sessions}
            loadingSessions={h.loadingSessions}
            onRevokeSession={h.handleRevokeSession}
            onRevokeAllSessions={h.handleRevokeAllSessions}
            touchedFields={{ newPassword: h.touchedFields.newPassword, confirmPassword: h.touchedFields.confirmPassword, newEmail: h.touchedFields.newEmail }}
            markTouched={h.markTouched}
          />

          {/* Wallet Section */}
          <SectionCard id="wallet" title={t('walletSection')} description={t('walletDescription')}>
            <LazyWeb3Boundary>
              <WalletSection onToast={(msg, type) => showToast(msg, type)} onConfirm={(title, msg) => showConfirm(title, msg)} />
            </LazyWeb3Boundary>
          </SectionCard>

          {/* Exchange Connections */}
          <Box id="exchanges" style={{ marginBottom: tokens.spacing[6], padding: tokens.spacing[6], borderRadius: tokens.radius['2xl'], background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`, boxShadow: tokens.shadow.sm }}>
            {h.userId && <ExchangeConnectionManager userId={h.userId} />}
          </Box>

          {/* Trader Links */}
          <SectionCard id="trader-links" title={t('myTraderAccounts')} description={t('myTraderAccountsDesc')}>
            {h.userId && <TraderLinksSection userId={h.userId} />}
          </SectionCard>

          {/* Trader Alerts */}
          <SectionCard id="alerts" title={t('traderAlertsTitle')} description={t('traderAlertsDesc2')}>
            <AdvancedAlerts isPro={isPro} isLoggedIn={!!h.userId} />
          </SectionCard>

          <NotificationsSection
            notifyFollow={h.notifyFollow} setNotifyFollow={h.setNotifyFollow}
            notifyLike={h.notifyLike} setNotifyLike={h.setNotifyLike}
            notifyComment={h.notifyComment} setNotifyComment={h.setNotifyComment}
            notifyMention={h.notifyMention} setNotifyMention={h.setNotifyMention}
            notifyMessage={h.notifyMessage} setNotifyMessage={h.setNotifyMessage}
            hapticEnabled={h.hapticEnabled} setHapticEnabled={h.setHapticEnabled}
            emailDigest={h.emailDigest} onEmailDigestChange={h.handleEmailDigestChange}
            onToast={showToast}
            onToggleSave={h.handleNotificationToggleSave}
          />

          <PrivacySection
            showFollowers={h.showFollowers} setShowFollowers={h.setShowFollowers}
            showFollowing={h.showFollowing} setShowFollowing={h.setShowFollowing}
            showProBadge={h.showProBadge} setShowProBadge={h.setShowProBadge}
            dmPermission={h.dmPermission} setDmPermission={h.setDmPermission}
            blockedUsers={h.blockedUsers} loadingBlockedUsers={h.loadingBlockedUsers}
            unblockingId={h.unblockingId} onUnblock={h.handleUnblock}
          />

          {/* Referral Section */}
          <SectionCard id="referral" title={t('referralTitle') || 'Referral Program'} description={t('referralDesc') || 'Invite friends and earn Pro rewards'}>
            <ReferralCard />
          </SectionCard>

          <AccountSection onLogout={h.handleLogout} onDeleteAccount={() => h.setShowDeleteAccountModal(true)} />

          <DeleteAccountModal
            isOpen={h.showDeleteAccountModal} onClose={() => h.setShowDeleteAccountModal(false)}
            password={h.deletePassword} setPassword={h.setDeletePassword}
            reason={h.deleteReason} setReason={h.setDeleteReason}
            error={h.deleteError} deleting={h.deletingAccount} onDelete={h.handleDeleteAccount}
          />

          {/* Floating Save Bar */}
          {h.hasUnsavedChanges() && (
            <Box style={{
              position: 'sticky', bottom: tokens.spacing[4],
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`, borderRadius: tokens.radius.xl,
              background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.accent.warning}40`,
              boxShadow: tokens.shadow.lg, display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: tokens.zIndex.sticky,
            }}>
              <Text size="sm" style={{ color: tokens.colors.accent.warning }}>{t('unsavedChanges')}</Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <Button variant="secondary" size="sm" onClick={async () => {
                  const confirmed = await showConfirm(t('discardChanges'), t('discardChangesConfirm'))
                  if (confirmed && h.userId) {
                    h.setTouchedFields({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })
                    h.setHandleAvailable(null); h.setAvatarFile(null); h.setCoverFile(null); h.loadProfile(h.userId)
                  }
                }} disabled={h.saving}>{t('discard')}</Button>
                <Button variant="primary" size="sm" onClick={h.handleSaveProfile} disabled={h.saving}>
                  {h.saving ? t('savingChanges') : t('saveAllChanges')}
                </Button>
              </Box>
            </Box>
          )}

          <Box style={{ height: tokens.spacing[12] }} />
        </Box>
      </Box>

      {/* Avatar Cropper Modal */}
      {h.showAvatarCropper && h.cropImageSrc && (
        <ImageCropper imageSrc={h.cropImageSrc} onCropComplete={h.handleAvatarCropComplete}
          onCancel={() => { h.setShowAvatarCropper(false); h.setCropImageSrc(null) }}
          onError={(message) => showToast(message, 'error')} aspectRatio={1} cropShape="round" title={t('cropAvatar')} />
      )}

      {/* Cover Cropper Modal */}
      {h.showCoverCropper && h.cropImageSrc && (
        <ImageCropper imageSrc={h.cropImageSrc} onCropComplete={h.handleCoverCropComplete}
          onCancel={() => { h.setShowCoverCropper(false); h.setCropImageSrc(null) }}
          onError={(message) => showToast(message, 'error')} aspectRatio={3} cropShape="rect" title={t('cropCover')} />
      )}

      {/* Responsive styles */}
      <style>{`
        @media (max-width: 768px) {
          .settings-sidebar { display: none !important; }
          .settings-mobile-nav { display: flex !important; }
          .settings-mobile-nav::-webkit-scrollbar { display: none; }
          .settings-mobile-profile-menu { display: block !important; }
        }
        @media (max-width: 400px) {
          .settings-mobile-nav { gap: ${tokens.spacing[1]} !important; }
        }
      `}</style>
      {/* MobileBottomNav rendered in root layout.tsx */}
    </Box>
  )
}


export default function SettingsPage() {
  return (
    <ErrorBoundary
      pageType="profile"
      onError={(error, errorInfo) => {
        logger.error('Settings page error:', { error: String(error), componentStack: errorInfo?.componentStack })
      }}
    >
      <Suspense fallback={
        <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
          <TopNav email={null} />
          <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              {[1, 2, 3].map(i => (
                <Box key={i} style={{ height: 120, borderRadius: tokens.radius.xl, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </Box>
          </Box>
        </Box>
      }>
        <SettingsContent />
      </Suspense>
    </ErrorBoundary>
  )
}
