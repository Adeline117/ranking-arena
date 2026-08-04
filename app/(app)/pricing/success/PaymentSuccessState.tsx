'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import type { TranslationFunction } from '@/app/components/Providers/LanguageProvider'
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import styles from './PaymentSuccessState.module.css'

export type PaymentVerificationStatus = 'verifying' | 'success' | 'error'

type PaymentSuccessStateProps = {
  status: PaymentVerificationStatus
  email: string | null
  retrying: boolean
  onRetry: () => void
  t: TranslationFunction
}

const CheckCircleIcon = ({ size = 64 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    focusable="false"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
  >
    <circle cx="12" cy="12" r="10" fill="var(--color-accent-success)" fillOpacity="0.15" />
    <circle cx="12" cy="12" r="10" stroke="var(--color-accent-success)" strokeWidth="2" />
    <path
      d="M8 12L11 15L16 9"
      stroke="var(--color-accent-success)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const StarIcon = ({ size = 20 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    focusable="false"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

const LoadingSpinner = ({ size = 24 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    focusable="false"
    className={styles.spinner}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

function WarningIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={80}
      height={80}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.15" />
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8V13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

export function PaymentSuccessLoadingFallback() {
  return (
    <Box
      className={styles.page}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading payment confirmation"
    >
      <Box aria-hidden="true" className={styles.background} />
      <Box className={`${styles.content} ${styles.compactContent}`}>
        <Box className={styles.stateIcon} style={{ color: 'var(--color-pro-gradient-start)' }}>
          <LoadingSpinner size={48} />
        </Box>
        <span className={styles.visuallyHidden}>Loading payment confirmation</span>
      </Box>
    </Box>
  )
}

export function PaymentSuccessState({
  status,
  email,
  retrying,
  onRetry,
  t,
}: PaymentSuccessStateProps) {
  const stateRef = useRef<HTMLDivElement>(null)
  const previousStatusRef = useRef(status)

  useEffect(() => {
    if (status !== 'verifying' && previousStatusRef.current !== status) {
      stateRef.current?.querySelector<HTMLElement>('[data-result-heading]')?.focus({
        preventScroll: true,
      })
    }
    previousStatusRef.current = status
  }, [status])

  const compact = status !== 'success'

  return (
    <Box className={styles.page} data-verification-status={status}>
      <Box aria-hidden="true" className={styles.background} />
      <Box className={`${styles.content} ${compact ? styles.compactContent : ''}`}>
        <Box
          ref={stateRef}
          className={styles.state}
          role={status === 'error' ? 'alert' : 'status'}
          aria-live={status === 'error' ? 'assertive' : 'polite'}
          aria-busy={status === 'verifying'}
        >
          {status === 'verifying' && (
            <>
              <Box
                className={styles.stateIcon}
                style={{ color: 'var(--color-pro-gradient-start)' }}
              >
                <LoadingSpinner size={80} />
              </Box>
              <Text
                as="h1"
                size="2xl"
                weight="black"
                className={styles.heading}
                data-result-heading
                tabIndex={-1}
              >
                {t('activatingMembership')}
              </Text>
              <Text size="md" color="secondary">
                {t('syncingSubscription')}
              </Text>
              <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[3] }}>
                {t('thisUsuallyTakesSeconds')}
              </Text>
            </>
          )}

          {status === 'success' && (
            <>
              <Box className={styles.stateIcon}>
                <CheckCircleIcon size={80} />
              </Box>

              <Text
                as="h1"
                size="2xl"
                weight="black"
                className={styles.heading}
                data-result-heading
                tabIndex={-1}
              >
                {t('paymentSuccess')}
              </Text>

              <Text size="md" color="secondary" className={styles.lead}>
                {t('congratsProMember')}
              </Text>

              <Box className={styles.successBadge}>
                <StarIcon size={18} />
                <Text size="md" weight="bold" style={{ color: tokens.colors.white }}>
                  {t('proMember')}
                </Text>
              </Box>

              <Box className={styles.onboardingCard}>
                <Text size="sm" weight="bold" className={styles.onboardingTitle}>
                  {t('proGetStarted')}
                </Text>
                <Box className={styles.steps}>
                  {[
                    { href: '/rankings', label: t('proStep1') },
                    { href: '/compare', label: t('proStep2') },
                    { href: '/settings', label: t('proStep3') },
                  ].map((step, index) => (
                    <Link
                      key={step.href}
                      href={step.href}
                      className={styles.stepLink}
                      aria-label={step.label}
                    >
                      <Box className={styles.stepCard}>
                        <span aria-hidden="true" className={styles.stepIndex}>
                          {index + 1}
                        </span>
                        <Text size="sm" color="secondary" className={styles.stepLabel}>
                          {step.label}
                        </Text>
                        <span aria-hidden="true" className={styles.stepArrow}>
                          →
                        </span>
                      </Box>
                    </Link>
                  ))}
                </Box>
              </Box>

              <Link href="/referral" className={styles.referralLink}>
                <Box className={styles.referralCard}>
                  <Box className={styles.referralCopy}>
                    <Text size="sm" weight="bold">
                      {t('inviteFriendsTitle')}
                    </Text>
                    <Text size="xs" color="secondary">
                      {t('inviteFriendsDesc')}
                    </Text>
                  </Box>
                  <Text size="sm" weight="bold" className={styles.referralCta}>
                    {t('inviteFriendsCta')} →
                  </Text>
                </Box>
              </Link>

              <Box className={styles.actions}>
                <Link
                  href="/rankings"
                  className={`${styles.actionControl} ${styles.primaryAction}`}
                >
                  {t('exploreProRankings')}
                </Link>
                <Link href="/" className={`${styles.actionControl} ${styles.secondaryAction}`}>
                  {t('startExploring')}
                </Link>
              </Box>

              <Text size="xs" color="tertiary" className={styles.receipt}>
                {email ? t('receiptSentTo').replace('{email}', email) : t('receiptEmailed')}
              </Text>
            </>
          )}

          {status === 'error' && (
            <>
              <Box className={styles.stateIcon} style={{ color: 'var(--color-accent-warning)' }}>
                <WarningIcon />
              </Box>

              <Text
                as="h1"
                size="2xl"
                weight="black"
                className={styles.heading}
                data-result-heading
                tabIndex={-1}
              >
                {t('paymentStatusUnconfirmed')}
              </Text>

              <Text size="md" color="secondary" className={styles.lead}>
                {t('paymentStatusUnconfirmedDesc')}
              </Text>

              <Text size="sm" color="tertiary" className={styles.supportCopy}>
                {t('contactSupportIfFails')}
              </Text>

              <Box className={styles.actions}>
                <Button
                  variant="primary"
                  size="lg"
                  onClick={onRetry}
                  loading={retrying}
                  disabled={retrying}
                  className={styles.retryButton}
                  style={{
                    background: 'var(--color-pro-badge-bg)',
                    border: 'none',
                    boxShadow: '0 4px 12px var(--color-pro-badge-shadow)',
                  }}
                >
                  {retrying ? t('retrying') : t('retryActivation')}
                </Button>
                <Link href="/" className={`${styles.actionControl} ${styles.secondaryAction}`}>
                  {t('backToHome')}
                </Link>
              </Box>
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}
