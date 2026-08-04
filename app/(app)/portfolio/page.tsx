'use client'

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import PageHeader from '@/app/components/ui/PageHeader'
import ErrorState from '@/app/components/ui/ErrorState'
import { useDialog } from '@/app/components/ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { bootstrapClientAuth } from '@/lib/auth/client-auth-bootstrap'
import { logger } from '@/lib/logger'
import { supabase } from '@/lib/supabase/client'

interface LegacyPortfolioConnection {
  id: string
  exchange: string
  label: string | null
  created_at: string
}

export default function PortfolioPage() {
  const { push } = useRouter()
  const { showConfirm } = useDialog()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [token, setToken] = useState<string | null>(null)
  const [connections, setConnections] = useState<LegacyPortfolioConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadConnections = useCallback(async (accessToken: string) => {
    setLoading(true)
    try {
      const response = await fetch('/api/portfolio', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      })
      const payload = (await response.json().catch(() => null)) as { data?: unknown } | null
      if (!response.ok || !Array.isArray(payload?.data)) {
        throw new Error(`Legacy portfolio inventory returned HTTP ${response.status}`)
      }
      setConnections(payload.data as LegacyPortfolioConnection[])
      setLoadFailed(false)
    } catch (error) {
      logger.error('Failed to load legacy portfolio inventory:', error)
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await bootstrapClientAuth(supabase.auth)
      if (cancelled) return
      if (result.status !== 'authenticated') {
        if (result.status === 'signed-out') {
          push('/login?redirect=/portfolio')
          return
        }
        setLoadFailed(true)
        setLoading(false)
        return
      }
      const accessToken = result.session?.access_token
      if (!accessToken) {
        setLoadFailed(true)
        setLoading(false)
        return
      }
      setToken(accessToken)
      await loadConnections(accessToken)
    })()
    return () => {
      cancelled = true
    }
  }, [loadConnections, push])

  const removeConnection = async (connection: LegacyPortfolioConnection) => {
    if (!token || deletingId) return
    const confirmed = await showConfirm(t('portfolioRemoveExchange'), t('portfolioRemoveConfirm'))
    if (!confirmed) return

    setDeletingId(connection.id)
    try {
      const response = await fetch(`/api/portfolio?id=${connection.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          ...getCsrfHeaders(),
        },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Legacy portfolio delete returned ${response.status}`)
      setConnections((current) => current.filter(({ id }) => id !== connection.id))
      showToast(t('portfolioRemoved'), 'success')
    } catch (error) {
      logger.error('Failed to remove legacy portfolio connection:', error)
      showToast(t('portfolioRemoveFailed'), 'error')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <PageHeader title={t('portfolioLegacyCleanup')} compact />

        <section style={styles.notice} aria-labelledby="legacy-portfolio-notice">
          <h2 id="legacy-portfolio-notice" style={styles.noticeTitle}>
            {t('portfolioLegacyTitle')}
          </h2>
          <p style={styles.copy}>{t('portfolioLegacyDescription')}</p>
          <Link href="/exchange/auth" style={styles.link}>
            {t('portfolioLegacySuccessor')}
          </Link>
        </section>

        {loadFailed ? (
          <ErrorState
            title={t('failedToLoad')}
            description={t('portfolioLoadFailed')}
            retry={() => token && void loadConnections(token)}
            variant="compact"
          />
        ) : loading ? (
          <p role="status" style={styles.copy}>
            {t('loading')}
          </p>
        ) : connections.length === 0 ? (
          <p role="status" style={styles.empty}>
            {t('portfolioLegacyEmpty')}
          </p>
        ) : (
          <section aria-label={t('portfolioConnectedExchanges')} style={styles.list}>
            {connections.map((connection) => (
              <div key={connection.id} style={styles.row}>
                <div>
                  <strong style={styles.exchange}>{connection.exchange}</strong>
                  {connection.label && connection.label !== connection.exchange ? (
                    <span style={styles.label}>{connection.label}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  style={styles.remove}
                  disabled={deletingId !== null}
                  onClick={() => void removeConnection(connection)}
                >
                  {deletingId === connection.id ? t('loading') : t('portfolioRemove')}
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  )
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--color-bg-primary)',
    paddingBottom: '80px',
  },
  container: {
    width: 'min(760px, calc(100% - 32px))',
    margin: '0 auto',
    padding: '24px 0',
    display: 'grid',
    gap: '20px',
  },
  notice: {
    padding: '20px',
    border: '1px solid var(--color-border-primary)',
    borderRadius: '14px',
    background: 'var(--color-bg-secondary)',
  },
  noticeTitle: { margin: '0 0 8px', fontSize: '18px' },
  copy: { margin: '0 0 12px', color: 'var(--color-text-secondary)', lineHeight: 1.6 },
  link: { color: 'var(--color-accent-primary)', fontWeight: 600 },
  empty: {
    margin: 0,
    padding: '24px',
    textAlign: 'center',
    color: 'var(--color-text-secondary)',
    border: '1px dashed var(--color-border-primary)',
    borderRadius: '12px',
  },
  list: { display: 'grid', gap: '10px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '14px 16px',
    border: '1px solid var(--color-border-primary)',
    borderRadius: '12px',
  },
  exchange: { textTransform: 'capitalize' },
  label: { marginLeft: '8px', color: 'var(--color-text-secondary)' },
  remove: {
    border: '1px solid var(--color-error)',
    color: 'var(--color-error)',
    background: 'transparent',
    borderRadius: '8px',
    padding: '8px 12px',
    cursor: 'pointer',
  },
}
