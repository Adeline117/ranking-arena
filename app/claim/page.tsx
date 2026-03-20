'use client'

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider }
    solana?: SolanaProvider
  }
}

interface SolanaProvider {
  isPhantom?: boolean
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>
  connect: () => Promise<{ publicKey: { toString: () => string } }>
}

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
import Link from 'next/link'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box, Text } from '@/app/components/base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'

// ============================================
// Types
// ============================================

interface SearchResult {
  handle: string
  source: string
  source_trader_id: string
  avatar_url?: string
  roi?: number
  arena_score?: number
}

// ============================================
// CEX/DEX platform lists
// ============================================

const CEX_PLATFORMS = [
  { value: 'binance_futures', label: 'Binance Futures', requiresPassphrase: false },
  { value: 'binance', label: 'Binance', requiresPassphrase: false },
  { value: 'bybit', label: 'Bybit', requiresPassphrase: false },
  { value: 'okx', label: 'OKX', requiresPassphrase: true },
  { value: 'bitget', label: 'Bitget', requiresPassphrase: true },
  { value: 'gateio', label: 'Gate.io', requiresPassphrase: false },
  { value: 'htx', label: 'HTX (Huobi)', requiresPassphrase: false },
]

const DEX_PLATFORMS = [
  'hyperliquid', 'gmx', 'gains', 'aevo', 'kwenta', 'vertex', 'dydx',
  'jupiter_perps', 'drift',
]

const SOLANA_PLATFORMS = ['jupiter_perps', 'drift']

function isDex(source: string): boolean {
  return DEX_PLATFORMS.some(p => source.toLowerCase() === p)
}

function isSolanaDex(source: string): boolean {
  return SOLANA_PLATFORMS.some(p => source.toLowerCase() === p)
}

// ============================================
// FAQ Data
// ============================================

function useFaqItems() {
  const { t } = useLanguage()
  return [
    { q: t('claimPageFaqWhat'), a: t('claimPageFaqWhatAnswer') },
    { q: t('claimPageFaqHow'), a: t('claimPageFaqHowAnswer') },
    { q: t('claimPageFaqExchanges'), a: t('claimPageFaqExchangesAnswer') },
    { q: t('claimPageFaqSafe'), a: t('claimPageFaqSafeAnswer') },
  ]
}

// ============================================
// Sub-components
// ============================================

function HeroSection() {
  const { t } = useLanguage()
  return (
    <Box style={{
      textAlign: 'center',
      padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
      marginBottom: tokens.spacing[6],
    }}>
      <h1 style={{
        fontSize: 'clamp(1.8rem, 4vw, 2.5rem)',
        fontWeight: 800,
        marginBottom: tokens.spacing[3],
        lineHeight: 1.2,
        color: tokens.colors.text.primary,
      }}>
        {t('claimPageTitle')}
      </h1>
      <p style={{
        fontSize: tokens.typography.fontSize.lg,
        color: tokens.colors.text.secondary,
        maxWidth: '600px',
        margin: '0 auto',
        lineHeight: 1.6,
      }}>
        {t('claimPageSubtitle')}
      </p>
    </Box>
  )
}

function BenefitsSection() {
  const { t } = useLanguage()
  const benefits = [
    { icon: '\u2714', text: t('claimPageBenefitVerified') },
    { icon: '\u270F', text: t('claimPageBenefitEdit') },
    { icon: '\u2B50', text: t('claimPageBenefitStandout') },
    { icon: '\u26A1', text: t('claimPageBenefitPriority') },
  ]

  return (
    <Box style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
      gap: tokens.spacing[4],
      marginBottom: tokens.spacing[8],
    }}>
      {benefits.map((b, i) => (
        <Box key={i} style={{
          padding: tokens.spacing[5],
          backgroundColor: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          alignItems: 'flex-start',
          gap: tokens.spacing[3],
        }}>
          <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>{b.icon}</span>
          <Text style={{
            fontSize: tokens.typography.fontSize.md,
            color: tokens.colors.text.primary,
            lineHeight: 1.5,
          }}>
            {b.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function SearchSection({ onSelect }: { onSelect: (result: SearchResult) => void }) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=10`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.traders || data.results || [])
      }
    } catch {
      // Search failed silently
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300)
    return () => clearTimeout(timer)
  }, [query, search])

  return (
    <Box style={{
      maxWidth: '600px',
      margin: `0 auto ${tokens.spacing[8]}`,
    }}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('claimPageSearchPlaceholder')}
        style={{
          width: '100%',
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          fontSize: tokens.typography.fontSize.lg,
          borderRadius: tokens.radius.lg,
          border: `2px solid ${tokens.colors.border.primary}`,
          backgroundColor: tokens.colors.bg.secondary,
          color: tokens.colors.text.primary,
          outline: 'none',
        }}
      />

      {searching && (
        <Text style={{ padding: tokens.spacing[3], color: tokens.colors.text.tertiary }}>
          {t('searching')}
        </Text>
      )}

      {results.length > 0 && (
        <Box style={{
          marginTop: tokens.spacing[2],
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.lg,
          overflow: 'hidden',
          backgroundColor: tokens.colors.bg.secondary,
        }}>
          {results.map((r, i) => (
            <button
              key={`${r.source}-${r.source_trader_id}-${i}`}
              onClick={() => onSelect(r)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                border: 'none',
                borderBottom: i < results.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                backgroundColor: 'transparent',
                color: tokens.colors.text.primary,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {r.avatar_url && (
                <img
                  src={r.avatar_url.startsWith('data:') ? r.avatar_url : '/api/avatar?url=' + encodeURIComponent(r.avatar_url)}
                  alt=""
                  style={{ width: 32, height: 32, borderRadius: '50%' }}
                />
              )}
              <Box style={{ flex: 1 }}>
                <Text style={{ fontWeight: 600 }}>{r.handle}</Text>
                <Text style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
                  {r.source}
                  {r.arena_score ? ` | Score: ${r.arena_score.toFixed(1)}` : ''}
                </Text>
              </Box>
            </button>
          ))}
        </Box>
      )}
    </Box>
  )
}

function StatsSection() {
  const { t } = useLanguage()

  return (
    <Box style={{
      display: 'flex',
      justifyContent: 'center',
      gap: tokens.spacing[8],
      marginBottom: tokens.spacing[8],
      padding: `${tokens.spacing[5]} 0`,
    }}>
      <Box style={{ textAlign: 'center' }}>
        <Text style={{
          fontSize: tokens.typography.fontSize['3xl'],
          fontWeight: 800,
          color: tokens.colors.accent.primary,
        }}>
          34K+
        </Text>
        <Text style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.sm }}>
          {t('claimPageTotalTraders')}
        </Text>
      </Box>
    </Box>
  )
}

function FaqSection() {
  const { t } = useLanguage()
  const faqItems = useFaqItems()
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <Box style={{
      maxWidth: '700px',
      margin: `0 auto ${tokens.spacing[8]}`,
    }}>
      <h2 style={{
        fontSize: tokens.typography.fontSize['2xl'],
        fontWeight: 700,
        textAlign: 'center',
        marginBottom: tokens.spacing[5],
        color: tokens.colors.text.primary,
      }}>
        {t('claimPageFaqTitle')}
      </h2>

      {faqItems.map((item, i) => (
        <Box key={i} style={{
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          padding: `${tokens.spacing[4]} 0`,
        }}>
          <button
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.md,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
              textAlign: 'left',
            }}
          >
            {item.q}
            <span style={{
              transform: openIndex === i ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.2s',
              flexShrink: 0,
              marginLeft: tokens.spacing[2],
            }}>
              &#9660;
            </span>
          </button>
          {openIndex === i && (
            <Text style={{
              marginTop: tokens.spacing[2],
              color: tokens.colors.text.secondary,
              lineHeight: 1.7,
              fontSize: tokens.typography.fontSize.sm,
            }}>
              {item.a}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

// ============================================
// Verification Flow Components
// ============================================

function CexVerifyForm({
  trader,
  onSuccess,
}: {
  trader: SearchResult
  onSuccess: () => void
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)

  const platform = CEX_PLATFORMS.find(p =>
    trader.source.startsWith(p.value.split('_')[0])
  )
  const needsPassphrase = platform?.requiresPassphrase ?? false

  const handleVerify = async () => {
    if (loading) return // Guard against double-click race condition
    if (!apiKey.trim() || !apiSecret.trim()) {
      showToast(t('fillApiKeySecret'), 'warning')
      return
    }

    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      // Step 1: Verify ownership (matches UID with trader)
      const verifyRes = await fetch('/api/exchange/verify-ownership', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          exchange: trader.source,
          traderId: trader.source_trader_id,
          source: trader.source,
          apiKey: apiKey.trim(),
          apiSecret: apiSecret.trim(),
          passphrase: passphrase.trim() || undefined,
        }),
      })

      const verifyData = await verifyRes.json()

      if (!verifyRes.ok || !verifyData.verified) {
        showToast(verifyData.message || t('claimApiKeyMismatch'), 'error')
        return
      }

      // Step 2: Submit claim (auto-approved after verification)
      const claimRes = await fetch('/api/traders/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          trader_id: trader.source_trader_id,
          source: trader.source,
          verification_method: 'api_key',
          verification_data: {
            verified_uid: verifyData.uid,
          },
        }),
      })

      const claimData = await claimRes.json()

      if (!claimRes.ok) {
        showToast(claimData.error || t('claimFailed'), 'error')
        return
      }

      showToast(t('claimVerifiedAutoApproved'), 'success')
      onSuccess()
    } catch (error) {
      showToast(t('claimFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box style={{ maxWidth: '500px', margin: '0 auto' }}>
      <h3 style={{ marginBottom: tokens.spacing[3] }}>{t('claimApiKeyVerifyTitle')}</h3>
      <p style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4], fontSize: tokens.typography.fontSize.sm }}>
        {t('claimApiKeyVerifyDesc')}
      </p>

      <Box style={{
        padding: tokens.spacing[3],
        backgroundColor: tokens.colors.accent.primary + '15',
        border: `1px solid ${tokens.colors.accent.primary}40`,
        borderRadius: tokens.radius.md,
        marginBottom: tokens.spacing[4],
      }}>
        <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, lineHeight: 1.5, fontWeight: 600 }}>
          {t('claimReadOnlyWarning')}
        </Text>
      </Box>

      <Box style={{ marginBottom: tokens.spacing[3] }}>
        <label style={{ display: 'block', marginBottom: tokens.spacing[1], fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>
          API Key
        </label>
        <input
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter your API Key"
          style={{
            width: '100%',
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            backgroundColor: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
          }}
        />
      </Box>

      <Box style={{ marginBottom: tokens.spacing[3] }}>
        <label style={{ display: 'block', marginBottom: tokens.spacing[1], fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>
          API Secret
        </label>
        <input
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder="Enter your API Secret"
          style={{
            width: '100%',
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            backgroundColor: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
          }}
        />
      </Box>

      {needsPassphrase && (
        <Box style={{ marginBottom: tokens.spacing[3] }}>
          <label style={{ display: 'block', marginBottom: tokens.spacing[1], fontWeight: 500, fontSize: tokens.typography.fontSize.sm }}>
            Passphrase
          </label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter your Passphrase"
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              backgroundColor: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
            }}
          />
        </Box>
      )}

      <Box style={{
        padding: tokens.spacing[3],
        backgroundColor: tokens.colors.accent.warning + '15',
        border: `1px solid ${tokens.colors.accent.warning}40`,
        borderRadius: tokens.radius.md,
        marginBottom: tokens.spacing[4],
      }}>
        <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
          {t('claimPageFaqSafeAnswer')}
        </Text>
      </Box>

      <button
        onClick={handleVerify}
        disabled={loading}
        style={{
          width: '100%',
          padding: tokens.spacing[3],
          fontSize: tokens.typography.fontSize.md,
          fontWeight: 600,
          borderRadius: tokens.radius.md,
          border: 'none',
          backgroundColor: loading ? tokens.colors.text.tertiary : tokens.colors.accent.primary,
          color: '#fff',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? t('verifying') : t('claimVerifyMethodApi')}
      </button>
    </Box>
  )
}

function DexVerifyForm({
  trader,
  onSuccess,
}: {
  trader: SearchResult
  onSuccess: () => void
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)

  const isSolana = isSolanaDex(trader.source)

  const handleWalletVerify = async () => {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        showToast(t('pleaseLoginFirst'), 'warning')
        return
      }

      let walletAddress: string
      let signature: string
      const timestamp = Date.now()
      const message = `I am claiming trader profile ${trader.source_trader_id} on Arena. Timestamp: ${timestamp}`

      if (isSolana) {
        // Solana wallet signing (Phantom, Solflare, etc.)
        const solanaProvider = window.phantom?.solana ?? window.solana
        if (!solanaProvider?.signMessage) {
          showToast(t('claimSolanaWalletRequired'), 'warning')
          return
        }

        const connectTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Wallet connection timed out. Please try again.')), 30000)
        )
        const resp = await Promise.race([solanaProvider.connect(), connectTimeout])
        walletAddress = resp.publicKey.toString()

        if (walletAddress.toLowerCase() !== trader.source_trader_id.toLowerCase()) {
          showToast(t('claimWalletMismatch'), 'error')
          return
        }

        const encodedMessage = new TextEncoder().encode(message)
        const signedMessage = await solanaProvider.signMessage(encodedMessage, 'utf8')
        // Convert Uint8Array signature to base64 for transmission
        signature = Buffer.from(signedMessage.signature).toString('base64')
      } else {
        // EVM wallet signing
        if (!window.ethereum) {
          showToast(t('claimWalletConnectFirst'), 'warning')
          return
        }

        const ethTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Wallet connection timed out. Please try again.')), 30000)
        )
        const accounts = await Promise.race([
          window.ethereum.request({ method: 'eth_requestAccounts' }),
          ethTimeout,
        ]) as string[]
        walletAddress = accounts[0]

        if (!walletAddress) {
          showToast(t('claimWalletConnectFirst'), 'warning')
          return
        }

        if (walletAddress.toLowerCase() !== trader.source_trader_id.toLowerCase()) {
          showToast(t('claimWalletMismatch'), 'error')
          return
        }

        signature = await window.ethereum.request({
          method: 'personal_sign',
          params: [message, walletAddress],
        }) as string
      }

      // Verify on server
      const verifyRes = await fetch('/api/traders/claim/verify-wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          wallet_address: walletAddress,
          signature,
          message,
          platform: trader.source,
          trader_key: trader.source_trader_id,
        }),
      })

      const verifyData = await verifyRes.json()

      if (!verifyRes.ok || !verifyData.data?.verified) {
        showToast(verifyData.error || t('claimWalletSignFailed'), 'error')
        return
      }

      // Submit claim
      const claimRes = await fetch('/api/traders/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          trader_id: trader.source_trader_id,
          source: trader.source,
          verification_method: 'signature',
          verification_data: {
            wallet_address: walletAddress,
            signature,
            message,
          },
        }),
      })

      const claimData = await claimRes.json()

      if (!claimRes.ok) {
        showToast(claimData.error || t('claimFailed'), 'error')
        return
      }

      showToast(t('claimVerifiedAutoApproved'), 'success')
      onSuccess()
    } catch (error) {
      const msg = error instanceof Error ? error.message : ''
      if (msg.includes('User rejected') || msg.includes('user rejected') || msg.includes('timed out')) {
        // User cancelled wallet interaction or timeout
        setLoading(false)
        if (msg.includes('timed out')) {
          showToast(t('claimWalletTimeout') || 'Wallet connection timed out', 'warning')
        }
        return
      }
      showToast(t('claimWalletSignFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box style={{ maxWidth: '500px', margin: '0 auto', textAlign: 'center' }}>
      <h3 style={{ marginBottom: tokens.spacing[3] }}>{t('claimWalletVerifyTitle')}</h3>
      <p style={{ color: tokens.colors.text.secondary, marginBottom: tokens.spacing[4], fontSize: tokens.typography.fontSize.sm }}>
        {t('claimWalletVerifyDesc')}
      </p>

      <Box style={{
        padding: tokens.spacing[4],
        backgroundColor: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        marginBottom: tokens.spacing[4],
      }}>
        <Text style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
          Wallet to verify:
        </Text>
        <Text style={{
          fontFamily: 'monospace',
          fontSize: tokens.typography.fontSize.sm,
          wordBreak: 'break-all',
          color: tokens.colors.text.primary,
          marginTop: tokens.spacing[1],
        }}>
          {trader.source_trader_id}
        </Text>
      </Box>

      <button
        onClick={handleWalletVerify}
        disabled={loading}
        style={{
          width: '100%',
          padding: tokens.spacing[3],
          fontSize: tokens.typography.fontSize.md,
          fontWeight: 600,
          borderRadius: tokens.radius.md,
          border: 'none',
          backgroundColor: loading ? tokens.colors.text.tertiary : tokens.colors.accent.primary,
          color: '#fff',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? t('claimWalletSigning') : t('claimWalletSignMessage')}
      </button>
    </Box>
  )
}

// ============================================
// Main Page Component
// ============================================

interface LinkedTrader {
  id: string
  trader_id: string
  source: string
  label: string | null
  is_primary: boolean
  display_order: number
  verified_at: string
  verification_method: string
  stats?: {
    arena_score?: number
    roi?: number
    pnl?: number
    rank?: number
    handle?: string
    avatar_url?: string
  } | null
}

function LinkedAccountsSidebar({
  linkedTraders,
  onRefresh,
}: {
  linkedTraders: LinkedTrader[]
  onRefresh: () => void
}) {
  const { t } = useLanguage()

  if (linkedTraders.length === 0) return null

  return (
    <Box style={{
      padding: tokens.spacing[4],
      backgroundColor: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.lg,
      border: `1px solid ${tokens.colors.border.primary}`,
      marginBottom: tokens.spacing[5],
      maxWidth: '600px',
      margin: `0 auto ${tokens.spacing[5]}`,
    }}>
      <Text style={{
        fontWeight: 700,
        fontSize: tokens.typography.fontSize.md,
        marginBottom: tokens.spacing[3],
        color: tokens.colors.text.primary,
      }}>
        {t('linkedAccounts') || 'Linked Accounts'} ({linkedTraders.length})
      </Text>
      {linkedTraders.map((lt) => (
        <Box key={lt.id} style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[2]} 0`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          {lt.stats?.avatar_url && (
            <img
              src={lt.stats.avatar_url.startsWith('data:') ? lt.stats.avatar_url : '/api/avatar?url=' + encodeURIComponent(lt.stats.avatar_url)}
              alt=""
              style={{ width: 28, height: 28, borderRadius: '50%' }}
            />
          )}
          <Box style={{ flex: 1 }}>
            <Text style={{ fontWeight: 600, fontSize: tokens.typography.fontSize.sm }}>
              {lt.stats?.handle || lt.trader_id}
              {lt.is_primary && (
                <span style={{
                  marginLeft: tokens.spacing[2],
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.accent.primary,
                  fontWeight: 500,
                }}>
                  Primary
                </span>
              )}
            </Text>
            <Text style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
              {lt.source}
              {lt.label ? ` - ${lt.label}` : ''}
              {lt.stats?.arena_score ? ` | Score: ${lt.stats.arena_score.toFixed(1)}` : ''}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

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
    }).catch(() => {})
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
                  alt=""
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

      <MobileBottomNav />
    </div>
  )
}

// window.ethereum type is already declared globally by @privy-io/react-auth
