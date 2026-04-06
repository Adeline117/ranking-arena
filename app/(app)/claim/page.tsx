'use client'

/**
 * /claim - Landing page for traders to claim their profiles.
 * Includes:
 * - Marketing content explaining benefits
 * - Search box to find trader profile
 * - Verification flow (API key for CEX, wallet for DEX)
 * - FAQ section
 * - Stats (claimed/total traders)
 */

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box, Text } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'

import { SearchResult, LinkedTrader, isDex } from './components/types'
import { HeroSection } from './components/HeroSection'
import { BenefitsSection } from './components/BenefitsSection'
import { SearchSection } from './components/SearchSection'
import { StatsSection } from './components/StatsSection'
import { FaqSection } from './components/FaqSection'
import { CexVerifyForm } from './components/CexVerifyForm'
import { DexVerifyForm } from './components/DexVerifyForm'
import { LinkedAccountsSidebar } from './components/LinkedAccountsSidebar'

// ============================================
// Main Page Component
// ============================================

export default function ClaimPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()

  const [user, setUser] = useState<import('@supabase/supabase-js').User | null>(null)
  const [selectedTrader, setSelectedTrader] = useState<SearchResult | null>(null)
  const [step, setStep] = useState<'search' | 'verify' | 'done'>('search')
  const [linkedTraders, setLinkedTraders] = useState<LinkedTrader[]>([])

  // Fetch linked traders for the user
  const fetchLinkedTraders = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch('/api/traders/linked', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setLinkedTraders(data.linked_traders || data.data?.linked_traders || [])
      }
    } catch {
      // Silent fail
    }
  }, [])

  // Check URL params for direct link
  useEffect(() => {
    const traderId = searchParams?.get('trader')
    const source = searchParams?.get('source')
    const handle = searchParams?.get('handle')
    const stepParam = searchParams?.get('step')

    if (traderId && source) {
      setSelectedTrader({
        handle: handle || traderId,
        source,
        source_trader_id: traderId,
      })
      if (stepParam === 'verify') {
        setStep('verify')
      }
    }
  }, [searchParams])

  // Check auth + fetch linked traders
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      if (data.user) {
        fetchLinkedTraders()
      }
    }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget
  }, [fetchLinkedTraders])

  const handleTraderSelect = (result: SearchResult) => {
    if (!user) {
      showToast(t('pleaseLoginFirst'), 'warning')
      return
    }
    setSelectedTrader(result)
    setStep('verify')
  }

  const handleClaimSuccess = () => {
    setStep('done')
    fetchLinkedTraders()
    setTimeout(() => {
      if (selectedTrader) {
        router.push(`/trader/${encodeURIComponent(selectedTrader.handle)}?source=${encodeURIComponent(selectedTrader.source)}`)
      }
    }, 2000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <TopNav />

      <Box style={{
        flex: 1,
        padding: `0 ${tokens.spacing[4]}`,
        maxWidth: '900px',
        margin: '0 auto',
        width: '100%',
      }}>
        {/* Hero */}
        <HeroSection />

        {/* Step: Search / Verify / Done */}
        {step === 'search' && (
          <>
            {linkedTraders.length > 0 && (
              <>
                <LinkedAccountsSidebar
                  linkedTraders={linkedTraders}
                  onRefresh={fetchLinkedTraders}
                />
                <Box style={{
                  textAlign: 'center',
                  marginBottom: tokens.spacing[5],
                }}>
                  <Text style={{
                    fontSize: tokens.typography.fontSize.lg,
                    fontWeight: 700,
                    color: tokens.colors.text.primary,
                  }}>
                    {t('linkAdditionalAccount') || 'Link Additional Account'}
                  </Text>
                  <Text style={{
                    fontSize: tokens.typography.fontSize.sm,
                    color: tokens.colors.text.secondary,
                    marginTop: tokens.spacing[1],
                  }}>
                    {t('linkAdditionalAccountDesc') || 'Search for another trader account to link to your profile.'}
                  </Text>
                </Box>
              </>
            )}
            <SearchSection onSelect={handleTraderSelect} />
            {linkedTraders.length === 0 && (
              <>
                <BenefitsSection />
                <StatsSection />
              </>
            )}
            <FaqSection />
          </>
        )}

        {step === 'verify' && selectedTrader && (
          <Box style={{ marginBottom: tokens.spacing[8] }}>
            {/* Trader info header */}
            <Box style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              padding: tokens.spacing[4],
              backgroundColor: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              marginBottom: tokens.spacing[5],
              maxWidth: '500px',
              margin: `0 auto ${tokens.spacing[5]}`,
            }}>
              {selectedTrader.avatar_url && (
                <img
                  src={selectedTrader.avatar_url.startsWith('data:') ? selectedTrader.avatar_url : '/api/avatar?url=' + encodeURIComponent(selectedTrader.avatar_url)}
                  alt={selectedTrader.handle || 'Trader'}
                  style={{ width: 40, height: 40, borderRadius: '50%' }}
                />
              )}
              <Box>
                <Text style={{ fontWeight: 700 }}>{selectedTrader.handle}</Text>
                <Text style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
                  {selectedTrader.source}
                </Text>
              </Box>
              <button
                onClick={() => { setStep('search'); setSelectedTrader(null) }}
                style={{
                  marginLeft: 'auto',
                  background: 'none',
                  border: 'none',
                  color: tokens.colors.text.tertiary,
                  cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                {t('change')}
              </button>
            </Box>

            {/* Verification form */}
            {!user ? (
              <Box style={{ textAlign: 'center' }}>
                <Text style={{ marginBottom: tokens.spacing[3] }}>
                  {t('pleaseLoginFirst')}
                </Text>
                <button onClick={() => useLoginModal.getState().openLoginModal()} style={{
                  color: tokens.colors.accent.primary,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  fontSize: 'inherit',
                  fontFamily: 'inherit',
                }}>
                  {t('loginToClaim')}
                </button>
              </Box>
            ) : isDex(selectedTrader.source) ? (
              <DexVerifyForm trader={selectedTrader} onSuccess={handleClaimSuccess} />
            ) : (
              <CexVerifyForm trader={selectedTrader} onSuccess={handleClaimSuccess} />
            )}
          </Box>
        )}

        {step === 'done' && (
          <Box style={{
            textAlign: 'center',
            padding: tokens.spacing[8],
          }}>
            <Box style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              backgroundColor: tokens.colors.accent.success + '20',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: `0 auto ${tokens.spacing[4]}`,
              fontSize: '2rem',
            }}>
              &#10003;
            </Box>
            <h2 style={{
              fontSize: tokens.typography.fontSize['2xl'],
              fontWeight: 700,
              marginBottom: tokens.spacing[3],
              color: tokens.colors.accent.success,
            }}>
              {t('claimVerifiedAutoApproved')}
            </h2>
            <Text style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4] }}>
              {t('redirectingToProfile')}
            </Text>
            {linkedTraders.length > 0 && (
              <LinkedAccountsSidebar
                linkedTraders={linkedTraders}
                onRefresh={fetchLinkedTraders}
              />
            )}
          </Box>
        )}
      </Box>

      {/* MobileBottomNav rendered in root layout */}
    </div>
  )
}

// window.ethereum type is already declared globally by @privy-io/react-auth
